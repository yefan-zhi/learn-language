# 英语口语陪练 · learn-language

用中文学**美式 / 英式**英语口语的网页工具。和 AI 扮演的英语母语者进行实时语音情景对话，旁边有一位**中文老师**在你每说完一句话后点评：

- 表达是否地道，给出更地道的说法（可点击收听美/英口音示范）
- 发音问题（具体到单词）和语调、重音、节奏
- 用**中文语音**直接说出来，像老师当面指导一样

对话结束后有**总结页**：整体评价与得分、本场景地道表达，以及逐句回放——你的每句录音、对应的问题（文字）和老师点评语音。练习记录保存在本机浏览器，可以随时重新打开。

在线使用：<https://yefan-zhi.github.io/learn-language/>（手机、平板、电脑都可以，推荐最新版 Chrome / Safari / Edge，戴耳机效果更好）

## 使用方法

1. 到 [Google AI Studio](https://aistudio.google.com/apikey) 申请一个 Gemini API Key（有免费额度）。
2. 打开网页 → 右上角 ⚙️ 设置 → 填入 Key → 点“测试 Key 并检测可用模型” → 保存。
3. 选择口音（美式/英式）、难度、模式（沉浸 / 辅助），挑一个场景开始对话。对方会先开口。
4. 点“结束并查看总结”查看逐句回放和整体点评。

## 工作原理

纯前端静态网站，不需要后端服务器，可以直接托管在 GitHub Pages：

| 功能 | 使用的 Gemini 接口（可在设置里改模型） |
| --- | --- |
| 角色实时语音对话 | Live API（WebSocket，默认 `gemini-2.5-flash-native-audio-preview-12-2025`） |
| 每句点评（听你的录音） | `generateContent` + 音频输入（默认 `gemini-2.5-flash`） |
| 老师中文语音 / 地道说法示范 | TTS（默认 `gemini-2.5-flash-preview-tts`，也可用设备自带语音） |

每句话的切分：从角色上一轮说完，到角色开始回应为止的麦克风音频，裁掉首尾静音后交给老师模型分析。老师语音会排在角色说完之后播放，期间暂时不把麦克风上传给对话模型，避免角色“听到”老师的中文。

## API Key 安全

- Key 只保存在你自己设备的浏览器（localStorage）里，只会直接发送给 Google 的 API，不经过任何第三方服务器。
- 强烈建议在 [Google Cloud 控制台 → 凭据](https://console.cloud.google.com/apis/credentials) 中为这个 Key 设置：
  - 应用限制 → 网站（HTTP referrer）：`https://yefan-zhi.github.io/*`（本地开发可再加 `http://localhost:5173/*`）
  - API 限制 → 只允许 Generative Language API
- 在公用电脑上用完后，可以在设置里点“清除 Key”。

## 本地开发

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 输出到 dist/
```

推送到 `main` 分支后，GitHub Actions（`.github/workflows/deploy.yml`）会自动构建并发布到 GitHub Pages。

## 来源与许可

本项目基于 Google 的开源项目 [ZackAkil/immersive-language-learning-with-live-api](https://github.com/ZackAkil/immersive-language-learning-with-live-api)（Immergo）二次开发，沿用 Apache License 2.0（见 `LICENSE`）。主要改动：去掉 Python 后端改为浏览器直连 Gemini API；界面中文化，专注中文母语者学习美式/英式英语；新增中文老师逐句点评（表达、发音、语调，语音播报）、课后逐句回放总结和本地练习记录；保留并修改了音频采集/播放与可视化组件。
