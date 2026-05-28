# Policy: Web research (optional)

This policy governs any capability that fetches information from the public internet for:
- requirements lookup (codes/standards)
- vendor cut sheets / product data
- API docs / technical references

## Modes
Web research must support these modes (configured by the host, not the model):
- **Off**: no network fetches.
- **Whitelist**: only fetch from an allowlisted set of domains (corporate policy).
- **Unrestricted**: fetch from any domain except an explicit denylist.

## Evidence + reproducibility
Any web research must produce durable evidence under the user Workspace:
- a snapshot of fetched pages (URL, timestamp, status, final URL after redirects)
- extracted text used for reasoning
- short citation metadata (URL + section headings if available)

Do not rely on memory of what a page “probably says”. Prefer quoting/paraphrasing from the captured evidence.

## Copyright / paywalls
- If a standard/code is paywalled (e.g., many NFPA documents), do not attempt to bypass access controls.
- If the needed text isn’t accessible, ask the user to provide the relevant excerpt (paste text or upload a PDF).
- When using user-provided excerpts, cite anchors (page/section) rather than reproducing large verbatim passages.

## Output style
- When the user asks to “comply with X”, respond with:
  - what sources you used (URLs or user-provided anchors)
  - the specific constraints distilled into checks/rules
  - any uncertainties and how to resolve them

