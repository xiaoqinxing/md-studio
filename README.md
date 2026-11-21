# md·studio

纯本地的 Markdown 编辑 / 阅读器。**单文件交付**：`index.html` 双击即用，断网可用，
正文、草稿、设置都只留在本机，没有任何后端请求。

## 直接使用

```bash
# 方式一：双击 / 拖进浏览器
xdg-open index.html

# 方式二：需要「原地打开 / 原地保存」本地文件时，用本地静态服务
python3 -m http.server 8765
# 打开 http://127.0.0.1:8765/index.html
```

Chrome / Edge 在 `file://` 下也可用 File System Access API（已实测）；
Firefox / Safari 会自动降级为「导入 + 下载导出」。

## 功能

- 三种视图：分栏实时预览 / 全宽源码 / 纯阅读，`Ctrl+Enter` 循环切换
- GFM：表格、任务列表（可点击回写源码）、删除线、自动链接、脚注
- KaTeX 公式（`$...$`、`$$...$$`）与 Mermaid 图表，主题切换自动重绘
- 代码高亮、语言标签、复制按钮；支持未知语言降级
- 目录大纲：随滚动高亮，窄屏为抽屉
- 文件：拖拽 / 打开 / 保存 / 另存为；导出 `.md` 与自包含 `.html`
- 自动保存草稿与视图设置；未保存时关闭页面会提醒
- 打印 / PDF：强制浅色、标题分页、图表与代码块不跨页
- 亮 / 暗 / 跟随系统；字号、行宽、正文衬线/无衬线可调
- 所有渲染结果经 DOMPurify 净化；原始 HTML 默认关闭

## 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl/Cmd+S` | 保存 |
| `Ctrl/Cmd+O` | 打开文件 |
| `Ctrl/Cmd+F` | 在源码中查找 |
| `Ctrl/Cmd+B` / `I` / `K` / `E` | 粗体 / 斜体 / 链接 / 行内代码 |
| `Ctrl/Cmd+Enter` | 切换视图 |
| `Ctrl/Cmd+Shift+L` | 切换主题 |
| `Ctrl/Cmd+\` | 收起 / 展开目录 |

## 开发

```bash
npm install
npm run build     # 生成 index.html（内联 JS/CSS/KaTeX 字体）
npm run dev       # 监听 src/ 自动重建
```

结构：

```text
src/app.js       视图、文件、持久化、导出、事件
src/editor.js    CodeMirror 6 编辑器与语法高亮
src/markdown.js  markdown-it / KaTeX / Mermaid / 净化
src/styles.css   全部样式（含打印）
src/index.html   模板，构建时注入依赖
build.mjs        esbuild + 字体内联
scripts/qa.mjs   渲染、主题、持久化、导出、打印回归
scripts/func.mjs 快捷键、XSS、降级保存、移动端
scripts/stress.mjs 大文档/编辑器延迟压力测试
```

## 已知边界

- 真·所见即所得（Typora 式）不在 v1 范围：Markdown 源码始终是唯一真源。
- 大文档（>120 KB）会延后预览刷新，编辑输入不受影响；1 MB 文档首次渲染约 1 秒、预览刷新数秒。
- 自动保存使用 localStorage（约 5 MB 配额）；超大文档建议直接保存到文件。
- 图片目前只支持 URL / base64，未做粘贴自动内嵌。
- 导出 HTML 保留当前主题与字体，KaTeX 字体内联，可离线打开或打印。

## 隐私

无网络请求、无遥测、无账号。DevTools 的 Network 面板可以直接验证：
除页面自身与 `data:`/`blob:` 外没有出站流量。
