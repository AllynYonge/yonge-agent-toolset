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
               素材: { 主图[], 详情图[], 规格图{}, 视频, 白底图 },
               警告[] } ],
  "errors": [...],                   # 阻断性问题
  "未生效配置": [...]                 # 「全局默认」里填了但脚本不消费的项
}
"""
import json
import os
import re
import sys

try:
    import openpyxl
except ImportError:
    print(json.dumps({"errors": ["缺少 openpyxl，请先执行 pip3 install openpyxl"]},
                     ensure_ascii=False))
    sys.exit(1)

IMG_EXT = (".jpg", ".jpeg", ".png")
VIDEO_EXT = (".mp4", ".mov")

REQUIRED = ["款号", "类目", "面料材质", "素材目录", "规格组名", "规格值", "尺码", "价格", "库存"]


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
    result = {"主图": [], "详情图": [], "规格图": {}, "视频": None, "白底图": None}
    warns = []
    if not mat_dir or not os.path.isdir(mat_dir):
        warns.append(f"素材目录不存在: {mat_dir}")
        return result, warns

    names = sorted(os.listdir(mat_dir))
    for n in names:
        full = os.path.join(mat_dir, n)
        if not os.path.isfile(full):
            continue
        low = n.lower()
        stem = os.path.splitext(n)[0]
        if n.startswith("主图") and low.endswith(IMG_EXT):
            result["主图"].append(full)
        elif n.startswith("详情图") and low.endswith(IMG_EXT):
            result["详情图"].append(full)
        elif n.startswith("SKU_") and low.endswith(IMG_EXT):
            result["规格图"][stem[4:]] = full
        elif n.startswith("视频") and low.endswith(VIDEO_EXT):
            result["视频"] = result["视频"] or full
        elif stem == "白底图" and low.endswith(IMG_EXT):
            result["白底图"] = full
        elif n.startswith("尺码表") and low.endswith(IMG_EXT):
            result["详情图"].append(full)   # 尺码表图归入详情图，放末尾
        elif low.endswith(".jfif"):
            warns.append(f"jfif 需转 jpg: {n}")

    result["主图"].sort()
    result["详情图"].sort(key=lambda p: (os.path.basename(p).startswith("尺码表"),
                                        os.path.basename(p)))

    if len(result["主图"]) < 3:
        warns.append(f"主图仅 {len(result['主图'])} 张，抖店建议 3-5 张")
    if not result["详情图"]:
        warns.append("缺少详情图")
    missing = [v for v in spec_values if v not in result["规格图"]]
    if missing:
        warns.append(f"缺少规格图: {'、'.join(missing)}（文件名应为 SKU_<规格值>.jpg）")
    return result, warns


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
# 其余项（发货模式/发货时效/售后政策/订单库存计数）目前取页面默认值，
# 填了不会生效 —— 必须显式告知用户，不能让人以为改了就管用。
CONSUMED_DEFAULTS = {"品牌", "运费模板", "商品状态", "尺码表模板", "商家编码规则"}


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
        materials, warns = resolve_materials(mat_dir, spec_values)

        row_errors = []
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
