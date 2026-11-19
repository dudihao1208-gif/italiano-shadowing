# 意大利语跟读（手机浏览器版）

不依赖电脑或本仓库的服务器。用手机浏览器打开这个网页后：

1. 选择手机里的音频或视频（YouTube 需要你先在手机里下载下来）。
2. 浏览器在本地用 Whisper 识别意大利语（首次下载约 43 MB 的 tiny 模型，之后会缓存）。
3. 把每句译成简体中文（免费 MyMemory 接口；失败时仍可跟读）。
4. 课程保存在本机 IndexedDB，同一网址下次可离线打开已保存的课。
5. 可「导出这一课」得到一个带音频的独立 HTML，和电脑版 `make_lesson.py` 的产物同类。

## 重要

- 需要 **https**（或电脑上的 localhost）。用 `file://` 直接打开时，模型、Web Worker 和麦克风通常不能用。
- 识别在手机本地完成，音视频不会上传到我们的服务器。翻译会请求 MyMemory。
- 建议单次几分钟；很长的视频在手机上会很慢，也可能发烫、占内存。
- 默认模型：`onnx-community/whisper-tiny`（量化，约 43 MB）。可改用 `whisper-base`（约 77 MB）换更准、更慢的识别。

## 本地预览

```bash
python3 -m http.server 8765 --directory /workspace/miraa/phone
# 打开 http://127.0.0.1:8765/
```
