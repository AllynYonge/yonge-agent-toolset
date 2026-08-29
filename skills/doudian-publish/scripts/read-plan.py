#!/usr/bin/env python3
"""读取抖店上架模板 Excel，输出规范化 JSON 到 stdout。

用法:
  python3 read-plan.py <xlsx路径> [--root 素材根目录] [--sku 款号1,款号2]

输出结构:
{
  "defaults": {...},                 # 「全局默认」Sheet
  "items": [ { 款号, 标题, 类目[], 面料材质, 材质含量[], 素材目录,
               规格组名, 规格值[], 尺码[], 价格{}, 库存{}, 库存明细{},
               商家编码规则, 商品状态, 尺码表模板, 运费模板,
               订单库存计数, 发货时效,
               素材: { 主图[], 详情图[], 规格图{}, 规格图回退[], 参考图[] },
               警告[] } ],
  "errors": [...],                   # 阻断性问题
  "未生效配置": [...]                 # 「全局默认」里填了但脚本不消费的项
}

「风格」不在模板里：上品时由 agent 看主图判定，通过 publish.mjs 的 `--styles <json>` 传入
（见 SKILL.md Step 2.5）。判断靠视觉，本脚本不参与。

「参考图」列支持两种写法：单元格内嵌图片（推荐），或填图片/目录路径（| 分隔）。
内嵌图片会被导出到 <素材目录>/参考图/ 下（幂等，同内容跳过），这是本脚本唯一的
写文件副作用。参考图仅供人工参考，不上传抖店。
"""
import hashlib
import json
import os
import re
import sys

try:
    import openpyxl
    from PIL import Image
except ImportError as exc:
    print(json.dumps({"errors": [f"缺少 Excel/图片依赖: {exc}，请执行 pip3 install openpyxl Pillow"]},
                     ensure_ascii=False))
    sys.exit(1)

IMG_EXT = (".jpg", ".jpeg", ".png")

REQUIRED = ["款号", "类目", "面料材质", "素材目录", "参考图",
            "规格组名", "规格值", "尺码", "价格", "库存"]

# 参考图导出目录名，位于该款素材目录下
REF_DIRNAME = "参考图"


def norm_header(v):
    return (str(v).strip().rstrip("*") if v is not None else "")


def split_pipe(v):
    if v is None:
        return []
    return [x.strip() for x in str(v).split("|") if x.strip()]


def parse_kv(v, cast=str):
    """解析 a:1|b:2 形式"""
    out = {}
    for part in split_pipe(v):
        if ":" not in part:
            continue
        k, _, val = part.partition(":")
        try:
            out[k.strip()] = cast(val.strip())
        except ValueError:
            out[k.strip()] = val.strip()
    return out


def parse_material(fabric, content):
    """面料材质 + 材质含量 -> [(材质, 含量)]"""
    fabric = (fabric or "").strip()
    content = (content or "").strip()
    if content and (":" in content or "；" in content or ";" in content):
        pairs = []
        for part in re.split(r"[;；|]", content):
            if ":" in part or "：" in part:
                k, _, v = re.split(r"[:：]", part, 1)
                pairs.append([k.strip(), int(float(v.strip()))])
        if pairs:
            return pairs
    pct = 100
    if content:
        m = re.search(r"\d+", content)
        if m:
            pct = int(m.group())
    return [[fabric, pct]] if fabric else []


def resolve_materials(mat_dir, spec_values):
    """按命名规范收集素材文件。严格前缀匹配，不做模糊推断。"""
    result = {"主图": [], "详情图": [], "规格图": {}, "规格图回退": [], "参考图": []}
    warns = []
    errors = []
    if not mat_dir or not os.path.isdir(mat_dir):
        warns.append(f"素材目录不存在: {mat_dir}")
        return result, warns, errors

    names = sorted(os.listdir(mat_dir))
    main_images = {}
    normalized_main = {}
    for n in names:
        full = os.path.join(mat_dir, n)
        if not os.path.isfile(full):
            continue
        low = n.lower()
        stem = os.path.splitext(n)[0]
        if n.startswith("主图") and low.endswith(IMG_EXT):
            base = re.sub(r"_1x1$", "", stem, flags=re.IGNORECASE)
            if stem.lower().endswith("_1x1"):
                normalized_main[base] = full
            else:
                main_images[base] = full

    # 规范化脚本生成的 *_1x1.jpg 优先于原图，避免同一张图片被重复上传。
    for base in sorted(set(main_images) | set(normalized_main), key=lambda x: [int(y) if y.isdigit() else y for y in re.split(r"(\d+)", x)]):
        result["主图"].append(normalized_main.get(base) or main_images[base])

    for n in names:
        full = os.path.join(mat_dir, n)
        if not os.path.isfile(full):
            continue
        low = n.lower()
        stem = os.path.splitext(n)[0]
        if n.startswith("主图") and low.endswith(IMG_EXT):
            continue
        if n.startswith("详情图") and low.endswith(IMG_EXT):
            result["详情图"].append(full)
        elif n.startswith("SKU_") and low.endswith(IMG_EXT):
            result["规格图"][stem[4:]] = full
        elif n.startswith("尺码表") and low.endswith(IMG_EXT):
            result["详情图"].append(full)   # 尺码表图归入详情图，放末尾
        elif low.endswith(".jfif"):
            warns.append(f"jfif 需转 jpg: {n}")

    result["主图"].sort(key=lambda p: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", os.path.basename(p))])
    result["详情图"].sort(key=lambda p: (os.path.basename(p).startswith("尺码表"),
                                        os.path.basename(p)))

    for image in result["主图"]:
        try:
            with Image.open(image) as opened:
                if opened.width != opened.height:
                    errors.append(f"主图必须为 1:1: {os.path.basename(image)}（当前 {opened.width}x{opened.height}）")
        except Exception as exc:
            errors.append(f"主图无法读取: {os.path.basename(image)}（{exc}）")

    if len(result["主图"]) < 3:
        warns.append(f"主图仅 {len(result['主图'])} 张，抖店建议 3-5 张")
    if not result["详情图"]:
        warns.append("缺少详情图（不阻断，可在草稿中补充）")
    missing = [v for v in spec_values if v not in result["规格图"]]
    if missing:
        if result["主图"]:
            fallback = result["主图"][0]
            for value in missing:
                result["规格图"][value] = fallback
            result["规格图回退"] = missing
            warns.append(f"缺少规格图: {'、'.join(missing)}，已默认使用主图 {os.path.basename(fallback)}")
        else:
            warns.append(f"缺少规格图: {'、'.join(missing)}（无主图可回退）")
    return result, warns, errors


def collect_embedded_images(ws):
    """按 (行, 列) 收集单元格内嵌/浮动图片的二进制数据。

    openpyxl 读到的图片挂在 worksheet._images 上，锚点 _from 是 0-based，
    这里统一转成 1-based，与 iter_rows 的行号对齐。
    """
    buckets = {}
    for image in getattr(ws, "_images", []):
        anchor = getattr(image, "anchor", None)
        frm = getattr(anchor, "_from", None)
        if frm is None:
            continue
        try:
            data = image._data()
        except Exception:
            continue
        ext = (getattr(image, "format", None) or "png").lower()
        if ext == "jpeg":
            ext = "jpg"
        buckets.setdefault((frm.row + 1, frm.col + 1), []).append((ext, data))
    return buckets


def export_embedded_refs(code, images, mat_dir):
    """把内嵌参考图写到 <素材目录>/参考图/ 下，返回 (路径列表, 错误列表)。

    文件名 参考图NN_<内容哈希前8位>.<ext>：内容变了才会产生新文件，
    重复跑不会累积同一张图，也不会覆盖用户手放进去的文件。
    """
    if not images:
        return [], []
    out_dir = os.path.join(mat_dir, REF_DIRNAME)
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as exc:
        return [], [f"参考图目录无法创建: {out_dir}（{exc}）"]

    paths, errors = [], []
    for i, (ext, data) in enumerate(images, start=1):
        digest = hashlib.sha1(data).hexdigest()[:8]
        target = os.path.join(out_dir, f"{REF_DIRNAME}{i:02d}_{digest}.{ext}")
        try:
            if not os.path.exists(target):
                with open(target, "wb") as fh:
                    fh.write(data)
            paths.append(target)
        except OSError as exc:
            errors.append(f"参考图写入失败: {os.path.basename(target)}（{exc}）")
    return paths, errors


def resolve_ref_paths(raw, root):
    """解析「参考图」列里手写的路径（| 分隔）。目录则收其下全部图片。"""
    paths, errors = [], []
    for part in split_pipe(raw):
        target = part if os.path.isabs(part) else os.path.join(root, part)
        target = os.path.abspath(target)
        if os.path.isdir(target):
            found = sorted(
                os.path.join(target, n) for n in os.listdir(target)
                if n.lower().endswith(IMG_EXT) and os.path.isfile(os.path.join(target, n))
            )
            if not found:
                errors.append(f"参考图目录里没有图片: {part}")
            paths.extend(found)
        elif os.path.isfile(target) and target.lower().endswith(IMG_EXT):
            paths.append(target)
        else:
            errors.append(f"参考图路径不存在或不是图片: {part}")
    return paths, errors


def read_defaults(wb):
    out = {}
    if "全局默认" not in wb.sheetnames:
        return out
    ws = wb["全局默认"]
    for row in ws.iter_rows(min_row=2, values_only=True):
        if row and row[0]:
            out[str(row[0]).strip()] = (str(row[1]).strip() if row[1] is not None else "")
    return out


# 「全局默认」里脚本真正会写入页面的配置项。
# 剩下的（发货模式 / 售后政策）目前取页面默认值，填了不会生效 ——
# 必须显式告知用户，不能让人以为改了就管用。
CONSUMED_DEFAULTS = {"品牌", "运费模板", "商品状态", "尺码表模板", "商家编码规则",
                     "订单库存计数", "发货时效"}


def check_defaults(defaults):
    """挑出用户填了但脚本不消费的配置项。"""
    return [k for k, v in defaults.items() if v and k not in CONSUMED_DEFAULTS]


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"errors": ["用法: read-plan.py <xlsx> [--root DIR] [--sku A,B]"]},
                         ensure_ascii=False))
        sys.exit(1)

    xlsx = sys.argv[1]
    root = os.path.dirname(os.path.abspath(xlsx))
    only = None
    args = sys.argv[2:]
    for i, a in enumerate(args):
        if a == "--root" and i + 1 < len(args):
            root = os.path.abspath(args[i + 1])
        if a == "--sku" and i + 1 < len(args):
            only = {x.strip() for x in args[i + 1].split(",") if x.strip()}

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    defaults = read_defaults(wb)

    if "商品" in wb.sheetnames:
        ws = wb["商品"]
    else:
        ws = wb.worksheets[0]

    headers = [norm_header(c.value) for c in ws[1]]
    idx = {h: i for i, h in enumerate(headers) if h}
    embedded = collect_embedded_images(ws)

    missing_cols = [c for c in REQUIRED if c not in idx]
    if missing_cols:
        print(json.dumps({"errors": [f"模板缺少必需列: {'、'.join(missing_cols)}"]},
                         ensure_ascii=False))
        sys.exit(1)

    items, errors = [], []

    def cell(row, name):
        i = idx.get(name)
        if i is None or i >= len(row):
            return None
        v = row[i]
        return v if v is None else (str(v).strip() if not isinstance(v, (int, float)) else v)

    for r, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        code = cell(row, "款号")
        if not code:
            continue
        # 第 2 行是说明行：所有说明行的款号列写的是提示文字，用长度和关键词过滤
        if r == 2 and ("例：" in str(code) or "货品编号" in str(code)):
            continue
        code = str(code).strip()
        if only and code not in only:
            continue
        remark = str(cell(row, "备注") or "")
        if "示例行" in remark:
            continue

        spec_values = split_pipe(cell(row, "规格值"))
        sizes = split_pipe(cell(row, "尺码"))
        prices = parse_kv(cell(row, "价格"), float)
        stocks = parse_kv(cell(row, "库存"), int)
        stock_detail = parse_kv(cell(row, "库存明细"), int)

        mat_raw = str(cell(row, "素材目录") or "")
        mat_dir = mat_raw if os.path.isabs(mat_raw) else os.path.join(root, mat_raw)
        materials, warns, asset_errors = resolve_materials(mat_dir, spec_values)

        # 参考图：优先用单元格内嵌图片，其次用列里手写的路径。
        ref_col = idx.get("参考图")
        ref_images = embedded.get((r, ref_col + 1), []) if ref_col is not None else []
        ref_paths, ref_errors = export_embedded_refs(code, ref_images, mat_dir)
        if not ref_paths:
            ref_paths, ref_errors = resolve_ref_paths(cell(row, "参考图"), root)
        materials["参考图"] = ref_paths

        row_errors = list(asset_errors) + ref_errors
        if not ref_paths:
            row_errors.append("缺少参考图（在「参考图」单元格里插入图片，或填图片/目录路径）")
        if not materials["主图"]:
            row_errors.append("缺少主图（至少需要主图01.jpg 等规范文件）")
        if not spec_values:
            row_errors.append("规格值为空")
        if not sizes:
            row_errors.append("尺码为空")
        miss_price = [v for v in spec_values if v not in prices]
        if miss_price:
            row_errors.append(f"以下规格值缺价格: {'、'.join(miss_price)}")
        if not stock_detail:
            miss_stock = [s for s in sizes if s not in stocks]
            if miss_stock:
                row_errors.append(f"以下尺码缺库存: {'、'.join(miss_stock)}")
        cat = [x.strip() for x in re.split(r"[>＞/]", str(cell(row, "类目") or "")) if x.strip()]
        if len(cat) < 2:
            row_errors.append("类目需写完整路径，如 服装>女装>时尚套装")

        if row_errors:
            errors.append({"行": r, "款号": code, "问题": row_errors})
            continue

        items.append({
            "行": r,
            "款号": code,
            "标题": str(cell(row, "商品标题") or ""),
            "类目": cat,
            "面料材质": parse_material(str(cell(row, "面料材质") or ""),
                                   str(cell(row, "材质含量") or "")),
            "素材目录": mat_dir,
            "规格组名": str(cell(row, "规格组名") or "颜色分类"),
            "规格值": spec_values,
            "尺码": sizes,
            "价格": prices,
            "库存": stocks,
            "库存明细": stock_detail,
            "商家编码规则": str(cell(row, "商家编码规则") or
                           defaults.get("商家编码规则", "{款号}-{规格值}-{尺码}")),
            "商品状态": str(cell(row, "商品状态") or defaults.get("商品状态", "下架")),
            "订单库存计数": str(cell(row, "订单库存计数") or
                          defaults.get("订单库存计数", "付款减库存")),
            "发货时效": str(cell(row, "发货时效") or defaults.get("发货时效", "48小时")),
            "尺码表模板": str(cell(row, "尺码表模板") or defaults.get("尺码表模板", "")),
            "运费模板": str(cell(row, "运费模板") or defaults.get("运费模板", "")),
            "素材": materials,
            "警告": warns,
        })

    print(json.dumps({"defaults": defaults, "items": items, "errors": errors,
                      "未生效配置": check_defaults(defaults)},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
