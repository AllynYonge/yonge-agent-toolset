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

「参考图」列支持三种写法：传统浮动图片、WPS DISPIMG 单元格图片，或填图片/目录路径（| 分隔）。
内嵌图片会被导出到 <素材目录>/参考图/ 下（幂等，同内容跳过），这是本脚本唯一的
写文件副作用。参考图仅供人工参考，不上传抖店。
"""
import hashlib
import json
import os
import posixpath
import re
import sys
from zipfile import ZipFile
from xml.etree import ElementTree as ET

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
            # _3x4 是早期版本遗留的派生图（当时把辅助图传到完整表单页的「主图3:4」区）。
            # 现在辅助图改在智能填写确认页的主图区上传，不再生成也不再使用它；
            # 目录里残留的旧文件一律忽略，不计入 1:1 主图集合。
            if stem.lower().endswith("_3x4"):
                continue
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
    """按 (行, 列) 收集传统浮动图片的二进制数据。

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


# WPS 的「单元格内图片」不是 OOXML drawing，而是自定义的 cellimages.xml，
# openpyxl 不会把它们放进 ws._images。单元格只保留一个 DISPIMG(ID, 1)
# 公式，图片二进制则由 cellimages.xml -> cellimages.xml.rels -> xl/media 引用。
_OOXML_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_OOXML_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
_DRAWING_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_XDR_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
_WPS_CELL_IMAGE_REL = "http://www.wps.cn/officeDocument/2020/cellImage"
_DISPIMG_RE = re.compile(r"DISPIMG\s*\(\s*[\"']([^\"']+)[\"']", re.IGNORECASE)


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _resolve_zip_target(source_part, target):
    """按 OOXML 关系规则解析相对 part 路径。"""
    if not target or target.startswith("#"):
        return None
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))


def _read_relationships(zf, rels_part, source_part):
    """读取一个 .rels part，返回 Relationship Id -> ZIP part 路径。"""
    try:
        root = ET.fromstring(zf.read(rels_part))
    except (KeyError, ET.ParseError):
        return {}
    out = {}
    for rel in root.findall(f"{{{_PKG_REL}}}Relationship"):
        if rel.attrib.get("TargetMode", "").lower() == "external":
            continue
        rid = rel.attrib.get("Id")
        target = _resolve_zip_target(source_part, rel.attrib.get("Target", ""))
        if rid and target:
            out[rid] = target
    return out


def _sheet_part_for_name(zf, sheet_name):
    """根据 Sheet 名找到其 worksheet XML part。"""
    workbook_part = "xl/workbook.xml"
    try:
        workbook = ET.fromstring(zf.read(workbook_part))
    except (KeyError, ET.ParseError):
        return None
    rels = _read_relationships(zf, "xl/_rels/workbook.xml.rels", workbook_part)
    for sheet in workbook.findall(f"{{{_OOXML_MAIN}}}sheets/{{{_OOXML_MAIN}}}sheet"):
        if sheet.attrib.get("name") != sheet_name:
            continue
        return rels.get(sheet.attrib.get(f"{{{_OOXML_REL}}}id"))
    return None


def _column_index(letters):
    value = 0
    for char in letters.upper():
        value = value * 26 + ord(char) - ord("A") + 1
    return value


def _cell_ref(ref):
    match = re.fullmatch(r"([A-Za-z]+)([0-9]+)", ref or "")
    if not match:
        return None
    return int(match.group(2)), _column_index(match.group(1))


def _wps_image_payloads(zf):
    """返回 WPS cellImage 名称 -> (扩展名, 二进制)。"""
    cellimages_part = "xl/cellimages.xml"
    try:
        root = ET.fromstring(zf.read(cellimages_part))
    except (KeyError, ET.ParseError):
        return {}

    rel_targets = _read_relationships(
        zf, "xl/_rels/cellimages.xml.rels", cellimages_part
    )
    payloads = {}
    for cell_image in root.iter():
        if _local_name(cell_image.tag) != "cellImage":
            continue
        c_nv_pr = next(
            (node for node in cell_image.iter() if _local_name(node.tag) == "cNvPr"),
            None,
        )
        blip = next(
            (node for node in cell_image.iter() if _local_name(node.tag) == "blip"),
            None,
        )
        if c_nv_pr is None or blip is None:
            continue
        name = c_nv_pr.attrib.get("name")
        rid = blip.attrib.get(f"{{{_OOXML_REL}}}embed")
        target = rel_targets.get(rid)
        if not name or not target:
            # r:link=external 或缺少关系时没有可导出的本地二进制。
            continue
        try:
            data = zf.read(target)
        except KeyError:
            continue
        ext = posixpath.splitext(target)[1].lstrip(".").lower() or "png"
        if ext == "jpeg":
            ext = "jpg"
        payloads[name] = (ext, data)
    return payloads


def collect_wps_cell_images(xlsx, sheet_name):
    """解析 WPS DISPIMG 单元格图片，返回 {(行, 列): [(ext, data), ...]}。

    WPS 把图片放在工作簿级的 xl/cellimages.xml 中，位置不在图片 XML
    内，而是由 worksheet XML 中的 DISPIMG("ID_...", 1) 单元格公式决定。
    解析失败时返回空映射，由调用方把无法恢复的 DISPIMG 明确报告出来。
    """
    buckets = {}
    try:
        with ZipFile(xlsx) as zf:
            sheet_part = _sheet_part_for_name(zf, sheet_name)
            if not sheet_part:
                return buckets
            try:
                sheet = ET.fromstring(zf.read(sheet_part))
            except (KeyError, ET.ParseError):
                return buckets
            payloads = _wps_image_payloads(zf)
            if not payloads:
                return buckets

            for cell in sheet.iter():
                if _local_name(cell.tag) != "c":
                    continue
                coordinate = _cell_ref(cell.attrib.get("r"))
                if coordinate is None:
                    continue
                formula = " ".join(
                    text for text in (
                        next((n.text or "" for n in cell if _local_name(n.tag) == "f"), ""),
                        next((n.text or "" for n in cell if _local_name(n.tag) == "v"), ""),
                    ) if text
                )
                match = _DISPIMG_RE.search(formula)
                if not match:
                    continue
                payload = payloads.get(match.group(1))
                if payload is not None:
                    buckets.setdefault(coordinate, []).append(payload)
    except (OSError, KeyError, ET.ParseError, ValueError):
        return {}
    return buckets


def is_dispimg_formula(value):
    return bool(_DISPIMG_RE.search(str(value or "")))


def merge_image_buckets(*sources):
    """合并浮动图和 WPS 图，并按单元格内二进制内容去重。"""
    merged = {}
    seen = {}
    for source in sources:
        for key, images in source.items():
            bucket = merged.setdefault(key, [])
            bucket_seen = seen.setdefault(key, set())
            for ext, data in images:
                digest = hashlib.sha1(data).digest()
                if digest in bucket_seen:
                    continue
                bucket_seen.add(digest)
                bucket.append((ext, data))
    return merged


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
    # 同时读取传统浮动图片和 WPS DISPIMG 单元格图片。后者不在
    # openpyxl 的 ws._images 中，必须从 XLSX ZIP 的 cellimages.xml 恢复。
    embedded = merge_image_buckets(
        collect_embedded_images(ws),
        collect_wps_cell_images(xlsx, ws.title),
    )

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
        ref_raw = cell(row, "参考图")
        ref_paths, ref_errors = export_embedded_refs(code, ref_images, mat_dir)
        if not ref_paths:
            # DISPIMG 是图片引用，不是用户填写的文件路径；不要把公式文本
            # 再送进路径解析器，否则会产生误导性的「路径不存在」错误。
            if is_dispimg_formula(ref_raw):
                ref_errors = [
                    "检测到 WPS DISPIMG 单元格图片，但图片数据无法从 XLSX 中读取"
                ]
            else:
                ref_paths, ref_errors = resolve_ref_paths(ref_raw, root)
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
