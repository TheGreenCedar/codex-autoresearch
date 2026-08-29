import fsp from "node:fs/promises";
import path from "node:path";
import { indent, node, ROOT, runCommand, type CommandSpec } from "./check-common.js";

const dashboardDemoExportOutput = "tmp/autoresearch-dashboard.check.html";
export const dashboardGeneratedDemoExport = `examples/demo-session/${dashboardDemoExportOutput}`;

export interface DashboardExportAssets {
  app: string;
  css: string;
}

export async function runDemoTrustCheck() {
  console.log("\n== demo trust ==");
  const doctor = await runCommand([
    "demo:doctor",
    node,
    [
      "scripts/autoresearch.mjs",
      "doctor",
      "--cwd",
      "examples/demo-session",
      "--check-benchmark",
      "--explain",
      "--json-full",
    ],
  ]);
  if (doctor.code !== 0) {
    console.log("fail demo:doctor");
    const output = `${doctor.stdout}${doctor.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }
  let doctorPayload: any;
  try {
    doctorPayload = JSON.parse(doctor.stdout);
  } catch (error) {
    console.log("fail demo:doctor");
    console.log(indent(`Could not parse demo doctor JSON: ${String(error)}`));
    return false;
  }
  if (doctorPayload.ok !== true || (doctorPayload.issues || []).length) {
    console.log("fail demo:doctor");
    console.log(indent(JSON.stringify({ ok: doctorPayload.ok, issues: doctorPayload.issues })));
    return false;
  } else {
    console.log("ok demo:doctor");
  }

  await fsp.mkdir(path.dirname(path.join(ROOT, dashboardGeneratedDemoExport)), {
    recursive: true,
  });
  await fsp.rm(path.join(ROOT, dashboardGeneratedDemoExport), { force: true });
  const exportResult = await runCommand(demoDashboardExportCommand());
  if (exportResult.code !== 0) {
    console.log("fail demo:export");
    const output = `${exportResult.stdout}${exportResult.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  const html = await fsp.readFile(path.join(ROOT, dashboardGeneratedDemoExport), "utf8");
  const parityIssues = dashboardExportAssetIssues(html, await readDashboardExportAssets());
  const showcaseIssues = demoShowcaseIssues(html);
  const forbidden = [
    { label: "Windows user path", pattern: /C:(?:\\+|\/)Users(?:\\+|\/)/ },
    {
      label: "Windows Program Files path",
      pattern: /C:(?:\\+|\/)Program Files(?:\\+|\/)/,
    },
    { label: "POSIX user path", pattern: /\/(?:Users|home)\/[^/"'<>\s]+/ },
    { label: "actionNonce", pattern: /actionNonce/ },
    { label: "action nonce header", pattern: /X-Autoresearch-Action-Nonce/ },
    { label: "dashboard action route", pattern: /\/actions\// },
    { label: "live actions panel", pattern: /live-actions-panel/ },
    { label: "action receipt", pattern: /action-receipt/ },
    {
      label: "branch-specific excluded commits",
      pattern: /Excluded \d+ unkept non-session commit/,
    },
    { label: "branch-specific final tree coverage", pattern: /Final tree coverage is missing/ },
  ].filter((entry) => entry.pattern.test(html));
  if (
    !html.includes(`"pluginVersion":"${pkg.version}"`) ||
    forbidden.length ||
    parityIssues.length ||
    showcaseIssues.length
  ) {
    console.log("fail demo:export");
    if (!html.includes(`"pluginVersion":"${pkg.version}"`)) {
      console.log(indent(`Demo export does not embed current pluginVersion ${pkg.version}.`));
    }
    if (showcaseIssues.length) {
      console.log(indent(`Demo export is not a valid showcase:\n${showcaseIssues.join("\n")}`));
    }
    if (parityIssues.length) {
      console.log(
        indent(
          `Demo export generated asset parity failed:\n${parityIssues.join(
            "\n",
          )}\nGenerated check path: ${dashboardGeneratedDemoExport}`,
        ),
      );
    }
    if (forbidden.length) {
      console.log(
        indent(
          `Demo export includes forbidden readout content:\n${forbidden
            .map((entry) => entry.label)
            .join("\n")}`,
        ),
      );
    }
    return false;
  }
  console.log("ok demo:export");
  return true;
}

export function demoDashboardExportCommand(): CommandSpec {
  return [
    "demo:export",
    node,
    [
      "scripts/autoresearch.mjs",
      "export",
      "--cwd",
      "examples/demo-session",
      "--output",
      dashboardDemoExportOutput,
      "--showcase",
    ],
  ];
}

async function readDashboardExportAssets(): Promise<DashboardExportAssets> {
  const [app, css] = await Promise.all([
    fsp.readFile(path.join(ROOT, "assets/dashboard-build/dashboard-app.js"), "utf8"),
    fsp.readFile(path.join(ROOT, "assets/dashboard-build/dashboard-app.css"), "utf8"),
  ]);
  return { app, css };
}

export function dashboardExportAssetIssues(html: string, assets: DashboardExportAssets): string[] {
  const issues: string[] = [];
  const styleBlocks = extractHtmlBlocks(html, "style");
  const scriptBlocks = extractHtmlBlocks(html, "script");
  const inlineCss = styleBlocks[0];
  const inlineApp = scriptBlocks[1];

  if (styleBlocks.length !== 1 || inlineCss === undefined) {
    issues.push(`expected exactly one inline dashboard style block, found ${styleBlocks.length}`);
  } else if (inlineCss !== escapedDashboardCss(assets.css)) {
    issues.push(
      "inline dashboard CSS does not match assets/dashboard-build/dashboard-app.css after </style escaping",
    );
  }

  if (scriptBlocks.length < 2 || inlineApp === undefined) {
    issues.push(
      `expected dashboard app in the second inline script block, found ${scriptBlocks.length} script block(s)`,
    );
  } else if (inlineApp !== escapedDashboardApp(assets.app)) {
    issues.push(
      "inline dashboard script does not match assets/dashboard-build/dashboard-app.js after </script escaping",
    );
  }

  return issues;
}

function extractHtmlBlocks(html: string, tagName: "script" | "style"): string[] {
  const pattern = new RegExp(`<${tagName}>\\r?\\n([\\s\\S]*?)\\r?\\n</${tagName}>`, "g");
  return [...html.matchAll(pattern)].map((match) => match[1] || "");
}

function escapedDashboardApp(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function escapedDashboardCss(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

function parseDashboardMeta(html: string): any | null {
  const match = html.match(/window\.__AUTORESEARCH_META__ = ([\s\S]*?);\n<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function demoShowcaseIssues(html: string): string[] {
  const meta = parseDashboardMeta(html);
  if (!meta) return ["missing or invalid embedded dashboard metadata"];
  const issues: string[] = [];
  if (meta.publicExport !== true || meta.settings?.publicExport !== true) {
    issues.push("public export flags are missing");
  }
  if (meta.showcaseMode !== true || meta.settings?.showcaseMode !== true) {
    issues.push("showcase flags are missing");
  }
  if (meta.deliveryMode !== "showcase" || meta.settings?.deliveryMode !== "showcase") {
    issues.push("deliveryMode is not showcase");
  }
  if (
    meta.viewModel?.trustState?.mode === "static-export" ||
    meta.viewModel?.processHygiene?.mode === "static-export"
  ) {
    issues.push("view model still reports static-export mode");
  }
  if (
    /Static export/i.test(JSON.stringify(meta.viewModel?.trustState?.reasons ?? [])) ||
    /Static export/i.test(JSON.stringify(meta.viewModel?.processHygiene?.warnings ?? []))
  ) {
    issues.push("view model still embeds static-export warnings");
  }
  return issues;
}
