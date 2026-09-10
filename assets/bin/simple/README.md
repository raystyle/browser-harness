# vendored simple tokenizer（D44）

上游 https://github.com/wangfenjin/simple Release v0.7.1 预编译产物 + cppjieba 词典。

- `windows-x64/simple.dll`、`linux-x64/libsimple.so`、`osx-x64/libsimple.dylib`、`osx-arm64/libsimple.dylib`：上游 Release zip 原样二进制（原 zip 内含各自的 dict/，此处统一用共享 LF 版本）。
- `dict/`：jieba 主词典族（jieba.dict.utf8 / hmm_model.utf8 / user.dict.utf8 / idf.utf8 / stop_words.utf8），取自 linux Release zip 的 LF 版本；上游血统 fxsjy/jieba（cppjieba 分发）。pos_dict/（词性标注用）不在 Jieba 构造参数内，未收录。
- `LICENSE-simple`：上游 LICENSE（MIT 或 GPL 双许可原文）。
- 版本锚点：simple v0.7.1（2026-02-23）。升级时四平台 zip + dict 同步换版并更新本文件。
