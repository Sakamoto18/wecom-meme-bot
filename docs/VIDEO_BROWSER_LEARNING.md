# 网页视频学习（2026-11-05）

视频学习复用 provider 的 B 站登录上下文，通过 `/bilibili-watch` 打开视频网页，从头正常播放，每约 1 秒截取播放器可见区域。9 张截图拼成网格，保留实际播放时间，每 27 秒交给视觉模型观察。学习路径不解析媒体直链，不调用 ffmpeg 或下载视频文件。

音频为可选补充：通过网页 Web Audio 录制正在播放的声音，转成临时 WAV 并用现有 ASR 转写。音频或转写失败不影响截图分析；结果和每日学习报告写明“本次未学习音频”。文字转写不等于确认音色、语调或音效。临时文件用完清理。

页面播放停滞 15 秒、登录失效或网页打不开时，任务保留具体失败原因，不回退下载。单次最多 300 秒，一个网页观看槽位，请求断开/失败/超时均关闭页面。每天从保存的 BV 队列继续；主页列表和辅助评论仍使用现有文本接口，视频画面全部来自网页截图。

配置沿用 `BILIBILI_PROVIDER_URL`（缺省回退到 `DOUYIN_PROVIDER_URL` 的服务根路径）。音频配置 `QQ_VIDEO_LEARNING_ASR_PYTHON` 与 `QQ_VIDEO_LEARNING_ASR_MODEL` 需传给 provider 进程。Windows 启动器已传入；其他部署若没有 ASR 则明确记录未学习音频。

验证：`node --test test/video-learning.test.js test/video-learning-store.test.js test/video-curriculum.test.js`；`python3 test/bilibili-browser-watch_test.py`。

每日主页报告以文字附一张完整 PNG 长图发送，两名接收人复用同一张图片。图片从报告文本渲染，HTML 转义且禁止外部资源；图片生成失败保留失败回执，后续按已有队列重试，不发送缺图的成功回执。1549 开头的已停用接收人不会恢复。
