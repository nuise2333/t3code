import { expect, it } from "vite-plus/test";

import { svgToSymbol } from "./fileIconThemeImport";

it("sanitizes an icon SVG into a symbol with ids scoped to that symbol", () => {
  const symbol = svgToSymbol(
    `<?xml version="1.0"?>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="24" height="24" fill="none" onload="alert(1)">
      <style>path { fill: red }</style>
      <script>alert(1)</script>
      <defs><linearGradient id="g"><stop offset="0" stop-color="#fff" /></linearGradient></defs>
      <path id="p" d="M0 0h24v24H0z" fill="url(#g)" onclick="alert(1)" />
      <use xlink:href="#p" />
      <use href="https://example.com/x.svg#p" />
      <image href="https://example.com/x.png" />
    </svg>`,
    "icons-1",
  );
  expect(symbol).not.toBeNull();
  const element = new DOMParser().parseFromString(symbol!, "image/svg+xml").documentElement;
  expect(element.localName).toBe("symbol");
  expect(element.getAttribute("id")).toBe("icons-1");
  expect(element.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(element.querySelector("g")?.getAttribute("fill")).toBe("none");
  expect(element.querySelector("style, script, image, [onload], [onclick]")).toBeNull();
  const gradientId = element.querySelector("linearGradient")?.getAttribute("id");
  expect(gradientId).toMatch(/^icons-1-/);
  expect(element.querySelector("path")?.getAttribute("fill")).toBe(`url(#${gradientId})`);
  const hrefs = [...element.querySelectorAll("use")].map(
    (use) => use.getAttribute("href") ?? use.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
  );
  expect(hrefs.filter((href) => href !== null)).toEqual([
    `#${element.querySelector("path")?.getAttribute("id")}`,
  ]);
});
