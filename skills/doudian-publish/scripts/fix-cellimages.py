#!/usr/bin/env python3
"""openpyxl 重存 xlsx 后，恢复 WPS 单元格内嵌图片（DISPIMG）的注册信息。

背景：
  openpyxl 不认识 WPS 私有的 cellimages 机制，重存 xlsx 时会把两处注册信息
  剥掉，导致 Excel/WPS 打开后「参考图」列显示 #REF!：
    1. [Content_Types].xml 中 /xl/cellimages.xml 的 Override 声明
    2. xl/_rels/workbook.xml.rels 中指向 cellimages.xml 的关系
  图片本体（xl/cellimages.xml、xl/_rels/cellimages.xml.rels、xl/media/*）
  虽然还留在包里，但没有注册信息就是孤儿资源，DISPIMG 全部失效。

用法：
  python3 fix-cellimages.py <目标.xlsx> <donor.xlsx>

  目标 = openpyxl 重存过的文件（如裂变后的模板）
  donor = 存盘前的原始文件（约定为「同名 + .bak」，或任意注册信息完好的副本）

动作：
  从 donor 复制 xl/cellimages.xml、xl/_rels/cellimages.xml.rels 及其引用的
  media 文件；用字符串替换补回两处注册信息（rId 自动避让冲突）；最后校验
  全部 sheet 的 DISPIMG 引用都有定义。已注册过则幂等跳过。

实现注意：
  一律用字节级字符串替换，不用 ElementTree 序列化 —— WPS 解析不了
  ElementTree 自动生成的 ns0: 前缀，cellimages.xml 必须保持 etc: 前缀、
  .rels 必须用默认命名空间（影刀 RPA 社区实测结论）。
  参考来源：
  - https://github.com/pandas-dev/pandas/issues/61888
  - https://www.yingdao.com/community/detaildiscuss?id=958242886957031424
"""

import re
import shutil
import sys
import tempfile
import zipfile

CELLIMAGES_PATH = "xl/cellimages.xml"
CELLIMAGES_RELS_PATH = "xl/_rels/cellimages.xml.rels"
CT_ENTRY = (
    b'<Override PartName="/xl/cellimages.xml" '
    b'ContentType="application/vnd.wps-officedocument.cellimage+xml"/>'
)
REL_ENTRY_TMPL = (
    b'<Relationship Id="rId{rid}" '
    b'Type="http://www.wps.cn/officeDocument/2020/cellImage" '
    b'Target="cellimages.xml"/>'
)


def die(msg: str) -> None:
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 3:
        die("用法: python3 fix-cellimages.py <目标.xlsx> <donor.xlsx>")
    target_path, donor_path = sys.argv[1], sys.argv[2]

    # ---------- 读取 donor 的 cellimages 部件 ----------
    try:
        donor = zipfile.ZipFile(donor_path)
    except zipfile.BadZipFile:
        die(f"donor 不是有效的 xlsx/zip: {donor_path}")
    if CELLIMAGES_PATH not in donor.namelist():
        die(f"donor 里没有 {CELLIMAGES_PATH}，无法作为图片来源: {donor_path}")

    donor_parts = {
        CELLIMAGES_PATH: donor.read(CELLIMAGES_PATH),
        CELLIMAGES_RELS_PATH: donor.read(CELLIMAGES_RELS_PATH)
        if CELLIMAGES_RELS_PATH in donor.namelist()
        else None,
    }
    # cellimages.xml.rels 里引用到的 media 一并带走
    media_files = []
    if donor_parts[CELLIMAGES_RELS_PATH]:
        rels_xml = donor_parts[CELLIMAGES_RELS_PATH].decode("utf-8", "replace")
        rid_to_target = dict(
            re.findall(
                r'<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"',
                rels_xml,
            )
        )
        # 兼容属性顺序不同的写法
        for m in re.finditer(r"<Relationship[^>]*/>", rels_xml):
            tag = m.group(0)
            rid = re.search(r'Id="([^"]+)"', tag)
            tgt = re.search(r'Target="([^"]+)"', tag)
            if rid and tgt:
                rid_to_target[rid.group(1)] = tgt.group(1)
        embeds = set(
            re.findall(
                r'r:embed="([^"]+)"',
                donor_parts[CELLIMAGES_PATH].decode("utf-8", "replace"),
            )
        )
        for rid in embeds:
            tgt = rid_to_target.get(rid)
            if not tgt or tgt.startswith("http"):
                continue
            norm = tgt.replace("../", "xl/").lstrip("/")
            if not norm.startswith("xl/"):
                norm = "xl/" + norm
            if norm in donor.namelist():
                media_files.append(norm)
    donor_media = {p: donor.read(p) for p in media_files}
    donor.close()

    # ---------- 读目标，检查现状 ----------
    try:
        zf = zipfile.ZipFile(target_path)
    except FileNotFoundError:
        die(f"目标文件不存在: {target_path}")
    except zipfile.BadZipFile:
        die(f"目标不是有效的 xlsx/zip: {target_path}")
    names = zf.namelist()
    parts = {n: zf.read(n) for n in names}
    order = list(names)
    zf.close()

    if CELLIMAGES_PATH in parts:
        print(f"目标里已有 {CELLIMAGES_PATH}（openpyxl 未删除时本脚本无需运行），"
              "仅确保注册信息存在。")

    ct = parts.get("[Content_Types].xml", b"")
    rels = parts.get("xl/_rels/workbook.xml.rels", b"")
    if not ct:
        die("目标包里没有 [Content_Types].xml，不是正常的 xlsx")
    if not rels:
        die("目标包里没有 xl/_rels/workbook.xml.rels，不是正常的 xlsx")

    ct_ok = b"cellimages" in ct
    rels_ok = b"cellimages" in rels
    if ct_ok and rels_ok:
        print("注册信息已存在，无需修补。")
        return

    # ---------- 补 [Content_Types].xml ----------
    if not ct_ok:
        if not ct.rstrip().endswith(b"</Types>"):
            die("[Content_Types].xml 结尾异常，拒绝盲改")
        parts["[Content_Types].xml"] = ct.replace(b"</Types>", CT_ENTRY + b"</Types>")
        print("已补 [Content_Types].xml 的 cellimages Override")

    # ---------- 补 workbook.xml.rels（rId 避让） ----------
    if not rels_ok:
        existing = [int(x) for x in re.findall(rb'Id="rId(\d+)"', rels)]
        rid = (max(existing) + 1) if existing else 1
        entry = REL_ENTRY_TMPL.replace(b"{rid}", str(rid).encode())
        parts["xl/_rels/workbook.xml.rels"] = rels.replace(
            b"</Relationships>", entry + b"</Relationships>"
        )
        print(f"已补 workbook.xml.rels 的 cellimages 关系 (rId{rid})")

    # ---------- 写回 ----------
    tmp = tempfile.mktemp(suffix=".xlsx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zo:
        for n in order:
            if n in parts:
                zo.writestr(n, parts[n])
        if CELLIMAGES_PATH not in parts:
            zo.writestr(CELLIMAGES_PATH, donor_parts[CELLIMAGES_PATH])
        if donor_parts[CELLIMAGES_RELS_PATH] and CELLIMAGES_RELS_PATH not in parts:
            zo.writestr(CELLIMAGES_RELS_PATH, donor_parts[CELLIMAGES_RELS_PATH])
        for p, data in donor_media.items():
            if p not in parts:
                zo.writestr(p, data)
    shutil.move(tmp, target_path)

    # ---------- 校验 ----------
    verify(target_path)


def verify(path: str) -> None:
    zf = zipfile.ZipFile(path)
    ok_ct = b"cellimages" in zf.read("[Content_Types].xml")
    ok_rels = b"cellimages" in zf.read("xl/_rels/workbook.xml.rels")
    has_ci = CELLIMAGES_PATH in zf.namelist()
    missing_def = set()
    if has_ci:
        ci = zf.read(CELLIMAGES_PATH).decode("utf-8", "replace")
        defined = set(re.findall(r'name="(ID_[0-9A-Fa-f]+)"', ci))
        for n in zf.namelist():
            if n.startswith("xl/worksheets/") and n.endswith(".xml"):
                sheet = zf.read(n).decode("utf-8", "replace")
                refs = set(re.findall(r'DISPIMG\("([^"]+)"', sheet))
                missing_def |= refs - defined
    zf.close()
    problems = []
    if not ok_ct:
        problems.append("[Content_Types].xml 仍缺 cellimages 声明")
    if not ok_rels:
        problems.append("workbook.xml.rels 仍缺 cellimages 关系")
    if not has_ci:
        problems.append("包里没有 cellimages.xml")
    if missing_def:
        problems.append(f"DISPIMG 引用缺定义: {sorted(missing_def)[:3]}")
    if problems:
        die("校验失败: " + "; ".join(problems))
    print("校验通过：注册信息齐全，所有 DISPIMG 引用均有定义。")


if __name__ == "__main__":
    main()
