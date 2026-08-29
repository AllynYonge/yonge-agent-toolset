#!/usr/bin/env python3
"""把非 1:1 的规范主图居中裁剪为 1:1。

只处理按命名规范识别的主图（主图01.* 至主图05.*），不猜测任意旧素材的用途。
原图保留，规范化图片以 主图NN_1x1.jpg 写入同一素材目录，read-plan.py 会优先使用它。
"""
import argparse
import os
import re
import sys

try:
    import openpyxl
    from PIL import Image, ImageOps
except ImportError as exc:
    print(f"缺少图片处理依赖: {exc}。请执行 pip3 install openpyxl Pillow", file=sys.stderr)
    sys.exit(1)

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".jfif"}
MAIN_RE = re.compile(r"^(主图\d{1,2})(?:_1x1)?$", re.IGNORECASE)


def norm_header(value):
    return str(value).strip().rstrip("*") if value is not None else ""


def cell(row, index, name):
    pos = index.get(name)
    if pos is None or pos >= len(row):
        return ""
    value = row[pos]
    return "" if value is None else str(value).strip()


def split_skus(value):
    return {x.strip() for x in str(value or "").split(",") if x.strip()}


def iter_material_dirs(xlsx, root, only):
    workbook = openpyxl.load_workbook(xlsx, data_only=True)
    sheet = workbook["商品"] if "商品" in workbook.sheetnames else workbook.worksheets[0]
    headers = [norm_header(c.value) for c in sheet[1]]
    index = {h: i for i, h in enumerate(headers) if h}
    root = os.path.abspath(root or os.path.dirname(os.path.abspath(xlsx)))
    seen = set()

    for row_no, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
        code = cell(row, index, "款号")
        if not code or (row_no == 2 and ("例：" in code or "货品编号" in code)):
            continue
        if only and code not in only:
            continue
        raw = cell(row, index, "素材目录")
        if not raw:
            continue
        directory = raw if os.path.isabs(raw) else os.path.join(root, raw)
        directory = os.path.abspath(directory)
        if directory not in seen:
            seen.add(directory)
            yield code, directory


def natural_key(name):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", name)]


def normalize_directory(code, directory):
    if not os.path.isdir(directory):
        print(f"素材目录不存在，跳过主图处理: {code} {directory}")
        return 0

    sources = {}
    for name in os.listdir(directory):
        full = os.path.join(directory, name)
        if not os.path.isfile(full):
            continue
        stem, ext = os.path.splitext(name)
        match = MAIN_RE.fullmatch(stem)
        if not match or ext.lower() not in IMAGE_EXT:
            continue
        # 已生成的规范图不作为原始输入，避免重复套裁。
        if stem.lower().endswith("_1x1"):
            continue
        sources[match.group(1)] = full

    changed = 0
    for base in sorted(sources, key=natural_key):
        source = sources[base]
        output = os.path.join(directory, f"{base}_1x1.jpg")
        try:
            with Image.open(source) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
                width, height = image.size
                side = min(width, height)
                if width != height:
                    left = (width - side) // 2
                    top = (height - side) // 2
                    image = image.crop((left, top, left + side, top + side))
                # 即使原图已经是 1:1，jfif/png 也转成统一 jpg，保证上传格式稳定。
                image.save(output, format="JPEG", quality=95, optimize=True)
            changed += 1
            print(f"规范化主图: {source} -> {output}")
        except Exception as exc:
            print(f"主图处理失败: {source}: {exc}", file=sys.stderr)
            return -1
    return changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("xlsx")
    parser.add_argument("--root")
    parser.add_argument("--sku")
    args = parser.parse_args()

    only = split_skus(args.sku)
    total = 0
    for code, directory in iter_material_dirs(args.xlsx, args.root, only):
        count = normalize_directory(code, directory)
        if count < 0:
            sys.exit(1)
        total += count
    print(f"主图 1:1 处理完成，共生成/更新 {total} 张规范图")


if __name__ == "__main__":
    main()
