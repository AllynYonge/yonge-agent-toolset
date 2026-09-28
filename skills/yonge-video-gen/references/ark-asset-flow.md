# 方舟 asset:// 素材流程

## 为什么需要它

方舟视频接口**拒绝直接上传含真人人脸的参考图**，只接受素材库里已授权的 `asset://<id>`。而 `CreateAsset` 只吃可公网访问的 HTTPS URL，不吃 Data URL——所以本地图片必须先落到对象存储拿到可读 URL，再交给方舟建素材。

由于事先无法可靠判断一张图里有没有真人脸，本技能**默认把所有本地参考图都转成 asset://**，而不是等服务端拒了再补救。

## 完整链路

```
本地图片
  ↓ PUT + sha1 签名
腾讯 COS（拿到带 2 小时预签名的 GET URL）
  ↓ ListAssetGroups / CreateAssetGroup（复用或创建 yonge-video-gen 组）
方舟素材组
  ↓ CreateAsset（AssetType: Image）
素材 ID
  ↓ GetAsset 轮询，3 秒一次，最多 3 分钟
Status: Active
  ↓
asset://<asset-id>  →  放进视频请求的 content
```

三种输入的分流：

| 输入 | 处理 |
|------|------|
| `asset://xxx` | 原样透传，不做任何请求 |
| `https://xxx` | 跳过 COS，直接拿去 `CreateAsset` |
| 本地路径 | 走完整链路 |

素材组在同一次运行内会缓存，不会每张图都打一次 `ListAssetGroups`。

## 凭证配置

方舟 AK/SK 与腾讯 COS 凭证放在 `~/.yonge/.yonge-skills/.env`（或项目级 `<cwd>/.yonge/.yonge-skills/.env`），与 API Key 集中一处维护：

```ini
# 方舟视频生成接口（必需，仅视频生成用）
ARK_API_KEY=...

# 方舟 OpenAPI 素材管理接口（asset:// 流程用）
ARK_ACCESS_KEY=AK...
ARK_SECRET_KEY=SK...
ARK_PROJECT_NAME=default          # 可选，缺省 default
ARK_ASSET_GROUP_ID=group-xxx      # 可选，缺省时自动创建/复用 yonge-video-gen 组

# 腾讯 COS（本地图先落 COS 才能建素材）
TENCENT_COS_SECRET_ID=...
TENCENT_COS_SECRET_KEY=...
TENCENT_COS_REGION=ap-guangzhou
TENCENT_COS_BUCKET=your-bucket-1300000000
TENCENT_COS_PREFIX=yonge-video-gen/   # 可选
TENCENT_COS_DOMAIN=...                # 可选
```

真实环境变量优先级高于 `.env` 文件，便于 CI 或临时覆盖：

| 变量 | 覆盖项 |
|------|--------|
| `ARK_ACCESS_KEY` / `VOLC_ACCESSKEY` | 方舟 AK |
| `ARK_SECRET_KEY` / `VOLC_SECRETKEY` | 方舟 SK |
| `ARK_PROJECT_NAME` | 项目名 |
| `ARK_ASSET_GROUP_ID` | 素材组 ID |

注意 **AK/SK 与 `ARK_API_KEY` 是两套东西**：`ARK_API_KEY` 用于视频生成接口，AK/SK 用于 OpenAPI 素材管理接口。只做文生视频、不带参考图时，只需要 `ARK_API_KEY`。

## 签名

两套签名体系，都在 `scripts/lib/ark-assets.ts` 里：

- **火山引擎 OpenAPI V4**（`HMAC-SHA256`）：用于 `open.volcengineapi.com` 的素材接口。签名串各段顺序和换行都不能动，改了就是 `SignatureDoesNotMatch`。
- **腾讯 COS**（`sha1` 体系）：用于 PUT 上传和生成预签名 GET URL。有效期 2 小时，足够方舟拉取。

## 排查

| 报错 | 原因与处理 |
|------|-----------|
| `缺少方舟 AK/SK` | `~/.yonge/.yonge-skills/.env` 里没有 `ARK_ACCESS_KEY`/`ARK_SECRET_KEY`。也可直接设同名环境变量 |
| `参考图缺少公网 URL，且腾讯 COS 配置不完整` | COS 四项（`TENCENT_COS_SECRET_ID/TENCENT_COS_SECRET_KEY/TENCENT_COS_REGION/TENCENT_COS_BUCKET`）没配齐。要么补齐，要么改用 `https://` 图片地址或已有的 `asset://` |
| `腾讯 COS 上传失败（403）` | secretId/secretKey 不对，或该 Key 没有目标 bucket 的写权限 |
| `方舟素材接口错误 SignatureDoesNotMatch` | AK/SK 不匹配，或系统时间偏差过大（V4 签名对时间敏感） |
| `方舟素材处理失败` | 图片格式或内容被方舟拒。换图，或确认图片能被公网正常访问 |
| `方舟素材处理超时` | 3 分钟内没变成 Active。素材还在处理，稍后用同一张图重试会复用已上传的（会新建一条素材，不会卡住） |
| 提到 `real person` / 真人 / 人脸 | 参考图含真人脸却走了直传。检查是否设了 `YONGE_VIDEO_GEN_ARK_DIRECT_IMAGE=1`，去掉即可 |

## 跳过转换

确认素材里没有真人、想省掉一次上传时：

```bash
YONGE_VIDEO_GEN_ARK_DIRECT_IMAGE=1 ${BUN_X} scripts/main.ts -p "..." --video out.mp4 --ref logo.png
```

参考图会以 Data URL 直接提交。真人图用了这个开关会被服务端拒。

## 素材会留在你的账号里

每次转换都会在方舟素材库创建一条素材，落在 `yonge-video-gen` 素材组（或 `assetGroupId` 指定的组）。它们不会自动清理，长期使用后建议在控制台定期整理。COS 上的原图同理，留在 `prefix` 指定的路径下。
