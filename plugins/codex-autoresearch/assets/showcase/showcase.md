# Showcase assets

`dashboard-demo.png` is the screenshot in the public README. Capture it from the live dashboard, not a static export. Keep the frame tight enough to read at README width: show the current decision before the packet trend, plus live freshness, without capturing the whole page.

The real-browser dashboard check captures a deterministic live fixture under `tmp/`. Before copying the reviewed desktop capture to `dashboard-demo.png`, inspect it with the 390×844 capture and confirm that the full decision is visible, chart labels remain legible, and no local absolute paths or personal data appear. Avoid browser chrome, cropped text, hover overlays, or unnecessary vertical scroll depth.

The plugin manifest may use compact SVG or PNG screenshots. In every surface, the image should look like a read-only product snapshot, not a control panel or a full-page report.
