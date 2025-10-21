// app/docs/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

const MD_URL = "/docs/README.md"; // Make sure public/docs/README.md exists

function b64(str: string) {
  if (typeof window === "undefined") return "";
  return window.btoa(unescape(encodeURIComponent(str)));
}

export default function DocsPage() {
  const [md, setMd] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(MD_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(`Could not load ${MD_URL}`)))
      .then(setMd)
      .catch((e) => setErr(String(e)));
  }, []);

  const srcDoc = useMemo(() => {
    if (!md) return "";

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Documentation</title>

  <!-- GitHub-ish baseline -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown.min.css" integrity="sha512-QqS9C7c1c6E3cJcJl4TKu2z2Qm0x8V0T8PMQW0l8GflbSb7k4HfTTwQ7O3Qm8aSg5sMnS87b7i8u1/b0z9X0XQ==" crossorigin="anonymous" referrerpolicy="no-referrer" />

  <style>
    /* =========================
       One Identity look & feel
       ========================= */
    :root{
      /* One Identity primary & neutrals */
      --oi-primary:       #00A3E0;
      --oi-primary-700:   #008CC2;
      --oi-primary-900:   #006E9A;
      --ink:              #0b0b0b;
      --ink-weak:         #2b2b2b;
      --bg:               #ffffff;
      --g-25:             #fcfcfc;
      --g-50:             #f7f7f8;
      --g-75:             #f2f6f8;
      --g-100:            #f2f2f2;
      --g-150:            #eeeeee;
      --g-200:            #e6e6e6;
      --g-300:            #d9d9d9;
      --shadow:           rgba(0,0,0,.06);
      --max-width:        840px;
      --radius:           12px;
    }

    html, body {
      margin: 0;
      padding: 0;
      color: var(--ink);
      background: var(--bg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial,
                   "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    ::selection { background: #E6F7FD; }

    /* Thin brand bar */
    .brandbar {
      height: 4px;
      width: 100%;
      background: linear-gradient(90deg,
        #7FD8F5 0%,
        var(--oi-primary) 35%,
        var(--oi-primary-700) 70%,
        var(--oi-primary-900) 100%);
    }

    .shell{
      min-height: calc(100vh - 4px);
      display: grid;
      place-items: start center;
      padding: 32px 16px 56px;
      background:
        radial-gradient(1100px 550px at 8% -20%, var(--g-50), transparent 62%),
        radial-gradient(900px 520px at 92% -25%, var(--g-25), transparent 65%),
        var(--bg);
    }

    .markdown-body{
      box-sizing: border-box;
      width: min(var(--max-width), 100vw - 32px);
      margin: 0 auto;
      padding: 28px 22px 56px;
      background: #fff;
      border: 1px solid var(--g-200);
      border-radius: var(--radius);
      box-shadow:
        0 12px 30px var(--shadow),
        0 2px 6px var(--shadow);
      line-height: 1.78;
      font-size: 16.5px;
      color: var(--ink);
    }

    /* ------- Headings with One Identity accent ------- */
    .markdown-body h1,
    .markdown-body h2,
    .markdown-body h3,
    .markdown-body h4{
      color: var(--ink);
      scroll-margin-top: 84px;
    }
    .markdown-body h1{
      border-bottom: 2px solid #E6F7FD;
      padding-bottom: .45rem;
      margin-bottom: 1.1rem;
    }
    .markdown-body h2,
    .markdown-body h3 {
      position: relative;
      padding-left: 12px;
      margin-top: 2rem;
      margin-bottom: 1rem;
    }
    .markdown-body h2::before,
    .markdown-body h3::before{
      content: "";
      position: absolute;
      left: 0;
      top: 0.3em;
      bottom: 0.3em;
      width: 4px;
      border-radius: 999px;
      background: var(--oi-primary);
    }

    /* ------- Links (brand) ------- */
    .markdown-body a,
    .markdown-body a:visited{
      color: var(--oi-primary-900);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .markdown-body a:hover{
      color: var(--oi-primary);
      background: #F0FAFF;
    }
    .markdown-body a:focus-visible{
      outline: 2px solid #BFEAFA;
      outline-offset: 2px;
      border-radius: 6px;
    }

    /* ------- Lists / TOC bullets use brand dot ------- */
    .markdown-body ul > li{
      list-style: none;
      position: relative;
      padding-left: 1rem;
    }
    .markdown-body ul > li::before{
      content: "";
      position: absolute;
      left: 0.2rem;
      top: 0.7em;
      width: 6px; height: 6px;
      border-radius: 999px;
      background: var(--oi-primary);
      opacity: .85;
    }
    .markdown-body ol > li::marker{
      color: var(--oi-primary-900);
      font-weight: 600;
    }

    /* ------- Blockquotes (tinted) ------- */
    .markdown-body blockquote{
      background: #F5FBFE;
      border-left: 6px solid var(--oi-primary);
      color: var(--ink-weak);
      padding: 12px 16px;
      border-radius: 8px;
    }

    /* ------- Horizontal rule ------- */
    .markdown-body hr{
      border: none;
      height: 2px;
      background: var(--g-200);
      border-radius: 999px;
      margin: 24px 0;
    }

    /* ------- Tables with subtle brand header ------- */
    .markdown-body table{
      display: block;
      width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
      border: 1px solid var(--g-200);
      border-radius: 10px;
      background: #fff;
    }
    .markdown-body th{
      background: #F0FAFF;              /* primary-tinted */
      border-bottom: 1px solid #DDF3FC;
      color: var(--ink);
      font-weight: 700;
      padding: 10px 12px;
      text-align: left;
    }
    .markdown-body td{
      padding: 10px 12px;
      border-top: 1px solid var(--g-200);
    }
    .markdown-body tbody tr:hover{
      background: #FBFEFF;
    }

    /* ------- Inline code ------- */
    .markdown-body :not(pre) > code{
      background: #F7F8F9;
      border: 1px solid var(--g-200);
      border-radius: 8px;
      padding: 0.18em 0.45em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
                   "Liberation Mono", "Courier New", monospace;
      font-size: .92em;
      color: var(--ink);
    }

    /* ------- Code blocks (gray for clarity, brand border) ------- */
    .markdown-body pre{
      position: relative;
      padding: 14px 16px 16px;
      background: #f6f6f6;
      border: 1px solid var(--g-200);
      border-left: 4px solid var(--oi-primary);
      border-radius: 10px;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      box-shadow: inset 0 1px 0 #fff;
    }
    .markdown-body pre code{
      background: transparent !important;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
                   "Liberation Mono", "Courier New", monospace;
      font-size: 13.25px;
      color: #111 !important;         /* hard-black text */
      white-space: pre;
    }
    .markdown-body pre code *{ color: inherit !important; }

    /* ------- Copy button with brand ------- */
    .copy-btn{
      position: absolute;
      top: 8px; right: 8px;
      padding: 6px 10px;
      font-size: 12px;
      line-height: 1;
      border: 1px solid #CDEFFC;
      border-radius: 8px;
      background: #FFFFFF;
      color: var(--oi-primary-900);
      cursor: pointer;
      box-shadow: 0 1px 1px var(--shadow);
      transition: transform .05s ease, background .15s ease, box-shadow .15s ease, color .15s ease, border-color .15s ease;
    }
    .copy-btn:hover{
      background: #F4FBFF;
      border-color: #BFEAFA;
      box-shadow: 0 2px 6px var(--shadow);
      color: var(--oi-primary);
    }
    .copy-btn:active{ transform: translateY(1px); }
    .copy-btn.copied{
      background: #E9FFF4;
      border-color: #CFEBDC;
      color: #0b0b0b;
    }

    /* Spacing harmony */
    .markdown-body pre,
    .markdown-body blockquote,
    .markdown-body table{
      margin-top: 1rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="brandbar"></div>
  <main class="shell">
    <article id="mdroot" class="markdown-body">Loading…</article>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    const MD = decodeURIComponent(escape(window.atob("${b64(md)}")));

    // Plain code (no syntax colors) for maximum clarity
    marked.setOptions({
      highlight: (code) => code
    });

    const html = marked.parse(MD);
    const root = document.getElementById("mdroot");
    root.innerHTML = html;

    // Copy buttons on code blocks
    function addCopyButtons(){
      const pres = root.querySelectorAll("pre");
      pres.forEach((pre) => {
        if (pre.querySelector(".copy-btn")) return;
        const btn = document.createElement("button");
        btn.className = "copy-btn";
        btn.type = "button";
        btn.textContent = "Copy";
        btn.addEventListener("click", async () => {
          const code = pre.querySelector("code");
          if (!code) return;
          try{
            await navigator.clipboard.writeText(code.innerText);
            const old = btn.textContent;
            btn.textContent = "Copied";
            btn.classList.add("copied");
            setTimeout(() => {
              btn.textContent = old || "Copy";
              btn.classList.remove("copied");
            }, 1200);
          }catch(e){
            const range = document.createRange();
            range.selectNodeContents(code);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        });
        pre.appendChild(btn);
      });
    }
    addCopyButtons();
  </script>
</body>
</html>`;
  }, [md]);

  if (err) {
    return (
      <main className="min-h-screen grid place-items-center p-6">
        <div className="max-w-xl w-full rounded-lg border p-4 text-red-700 bg-red-50">
          {err}
        </div>
      </main>
    );
  }

  if (!srcDoc) {
    return (
      <main className="min-h-screen grid place-items-center p-6 text-slate-700">
        Loading documentation…
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <iframe
        title="Documentation"
        srcDoc={srcDoc}
        style={{
          display: "block",
          border: 0,
          width: "100vw",
          height: "100vh",
          background: "transparent",
        }}
      />
    </main>
  );
}
