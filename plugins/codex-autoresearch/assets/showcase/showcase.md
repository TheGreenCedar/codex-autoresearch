# Showcase assets

`dashboard-demo.png` is the screenshot in the public README. Capture it from the bundled 100-packet showcase export, not the synthetic browser stress fixture. Keep the frame tight enough to read at README width: show populated chart points and the selected run's real metric details without capturing the whole page.

The real-browser dashboard check captures the deterministic showcase as `tmp/dashboard-operator-demo-details.png`. Before copying it to `dashboard-demo.png`, inspect it with the 390×844 dashboard capture and confirm that chart labels remain legible, selected-run details are populated, and no local absolute paths or personal data appear. Avoid browser chrome, cropped text, empty placeholders, hover overlays, or unnecessary vertical scroll depth.

The plugin manifest may use compact SVG or PNG screenshots. In every surface, the image should look like a read-only product snapshot, not a control panel or a full-page report.
