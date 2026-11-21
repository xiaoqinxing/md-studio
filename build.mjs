import { build } from "esbuild";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const p = (...s) => path.join(root, ...s);
const read = (f) => fsp.readFile(p(f), "utf8");
const watch = process.argv.includes("--watch");

const inlineFonts = (css, dir) => {
  const cache = new Map();
  // 只保留 woff2，把其余格式与整个 src 声明一起替换掉，控制体积
  return css.replace(
    /src:\s*url\(['"]?fonts\/([^)'"]+\.woff2)['"]?\)\s*format\((["'])woff2\2\)[^;]*;/g,
    (_m, file) => {
      if (!cache.has(file)) {
        cache.set(file, fs.readFileSync(path.join(dir, "fonts", file)).toString("base64"));
      }
      return `src:url(data:font/woff2;base64,${cache.get(file)}) format("woff2");`;
    },
  );
};

let lastSize = 0;

async function run() {
  const t0 = Date.now();
  const bundle = await build({
    entryPoints: [p("src/app.js")],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2021"],
    write: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  const js = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

  const [css, katexCssRaw, mermaid, tpl] = await Promise.all([
    read("src/styles.css"),
    read("node_modules/katex/dist/katex.min.css"),
    read("node_modules/mermaid/dist/mermaid.min.js"),
    read("src/index.html"),
  ]);

  const katexCss = inlineFonts(katexCssRaw, p("node_modules/katex/dist"));
  // Mermaid 占 2.7 MB：gzip + base64 后约 1 MB，运行时解压，避免整包解析
  const mermaidGz = zlib
    .gzipSync(Buffer.from(mermaid), { level: 9 })
    .toString("base64");

  const html = tpl
    .replace("/*__APP_CSS__*/", () => css)
    .replace("/*__KATEX_CSS__*/", () => katexCss)
    .replace("/*__MERMAID_GZ__*/", () => mermaidGz)
    .replace("/*__APP_JS__*/", () => js);

  await fsp.writeFile(p("index.html"), html);
  lastSize = Buffer.byteLength(html);
  console.log(
    `built index.html  ${(lastSize / 1024 / 1024).toFixed(2)} MB  ${Date.now() - t0} ms`,
  );
}

await run();

if (watch) {
  let timer = null;
  fs.watch(p("src"), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => run().catch((e) => console.error(e.message)), 80);
  });
  console.log("watching src/ ...");
}
