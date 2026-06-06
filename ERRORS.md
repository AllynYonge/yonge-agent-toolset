## A股公告 PDF 本地解析
**什么不起作用：** 本机缺少 `pdftotext`、`qpdf`、`mutool`、`pdfinfo`，Python 环境也没有 `PyPDF2/pdfplumber`；直接 `pip install --user pypdf` 因 externally-managed-environment 被拒绝。
**什么起作用了：** 使用官方公告/PDF 链接的 HTTP 可达性校验，结合 Grok Search 与财经平台公告摘要交叉验证关键数字；报告中对无法直接从本机 PDF 抽取的字段标注数据局限。
**下次注意：** 类似 A 股 PDF 报告任务先检查是否已有可用解析工具；若没有，不要反复尝试本机解析，优先使用官方链接、公告摘要和多源交叉验证。
