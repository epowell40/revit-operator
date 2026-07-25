namespace RevitBridge.Operator
{
    internal static class OperatorWebUiHtml
    {
        public static string Html => @"<!doctype html>
<html>
  <head>
    <meta charset=""utf-8"" />
    <meta name=""viewport"" content=""width=device-width, initial-scale=1"" />
    <title>Operator</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Segoe UI, Arial, sans-serif; }
      .wrap { display: flex; flex-direction: column; height: 100vh; }
      .top { padding: 10px 12px; border-bottom: 1px solid rgba(127,127,127,0.25); }
      .bar { display:flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
      .title { font-weight: 600; }
      .controls { display:grid; gap: 8px; align-items: center; justify-items: end; flex: 1 1 480px; min-width: 0; }
      .controlRow { display:flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; }
      .controlRowPrimary { justify-content: flex-end; }
      .controlRowPolicies { justify-content: flex-end; }
      .policy { display:flex; gap: 8px; align-items: center; font-size: 12px; opacity: 0.9; }
      select { padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.35); background: transparent; }
      .main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0,1fr) minmax(220px,34%); }
      .left { min-width: 0; min-height: 0; }
      .chatPane { height: 100%; min-height: 0; display: flex; flex-direction: column; }
      .right { border-left: 1px solid rgba(127,127,127,0.25); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .paneScroll { padding: 10px 12px; overflow: auto; min-height: 0; }
      .eventsPane { border-bottom: 1px solid rgba(127,127,127,0.25); background: rgba(127,127,127,0.03); }
      .event { border: 1px solid rgba(127,127,127,0.18); border-radius: 8px; padding: 8px 10px; margin: 8px 0; white-space: pre-wrap; font-size: 12px; opacity: 0.92; }
      /* Keep the right column focused on Actions only. */
      .eventsPane { display: none; }
      #cloudDetails, #attachDetails, #toolsDetails { display: none; }
      .msg { margin: 10px 0; display:flex; flex-direction: column; gap: 4px; }
      .msg.user { align-items: flex-end; }
      .role { font-size: 12px; opacity: 0.75; margin-bottom: 2px; display:flex; justify-content: space-between; align-items: center; gap: 8px; }
      .role .roleText { flex: 1; min-width: 0; }
      .role .speakBtn { padding: 4px 8px; font-size: 12px; }
      .bubble { line-height: 1.4; max-width: 92%; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(127,127,127,0.22); background: rgba(127,127,127,0.06); }
      .msg.user .bubble { background: rgba(40,120,200,0.10); border-color: rgba(40,120,200,0.30); }
      .bubble .mdSpacer { height: 8px; }
      .bubble .mdHeading { font-weight: 650; margin: 10px 0 6px; }
      .bubble .mdH1 { font-size: 16px; }
      .bubble .mdH2 { font-size: 14px; }
      .bubble .mdH3 { font-size: 13px; }
      .bubble .mdPara { margin: 2px 0; }
      .bubble .mdBullet { margin: 2px 0; padding-left: 14px; text-indent: -10px; }
      .bubble .inlineCode { font-family: ui-monospace, Consolas, monospace; font-size: 12px; padding: 1px 4px; border-radius: 6px; border: 1px solid rgba(127,127,127,0.22); background: rgba(0,0,0,0.06); }
      .bubble .codeBlock { margin: 8px 0; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(127,127,127,0.22); background: rgba(0,0,0,0.06); overflow: auto; max-height: 320px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre; }
      .actions { padding-top: 0; }
      .action { border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
      .action .hdr { display:flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; }
      .action .path { font-family: ui-monospace, Consolas, monospace; font-size: 12px; opacity: 0.9; overflow-wrap: anywhere; word-break: break-word; }
      .action .status { font-size: 12px; opacity: 0.8; }
      .action .summary { font-size: 12px; opacity: 0.85; margin-top: 4px; white-space: pre-wrap; }
      .action .resultLinks { margin-top: 6px; display:flex; gap: 8px; flex-wrap: wrap; }
      .action .resultLinks button { padding: 6px 10px; font-size: 12px; }
      .action .approveRow { margin-top: 8px; display:flex; gap: 8px; flex-wrap: wrap; }
      .action .approveRow button { padding: 6px 10px; }
      .action .confirmRow { margin-top: 8px; display:flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .action .confirmRow .lbl { font-size: 12px; opacity: 0.85; }
      .action .confirmRow input { padding: 8px 10px; min-width: 240px; flex: 1; }
      .action .planInner { margin-top: 6px; }
      .action table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .action th, .action td { border-bottom: 1px solid rgba(127,127,127,0.22); padding: 6px 6px; vertical-align: top; }
      .action th { text-align: left; opacity: 0.85; }
      .action td.mono { font-family: ui-monospace, Consolas, monospace; }
      .action pre { margin: 6px 0 0; padding: 6px 8px; border-radius: 6px; overflow: auto; max-height: 220px; font-size: 12px; }
      .action .copyRow { margin-top: 6px; display:flex; gap: 8px; flex-wrap: wrap; }
      .action .copyRow button { padding: 6px 10px; }
      a { color: inherit; text-decoration: underline; }
      a:hover { opacity: 0.9; }
      .composer { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(127,127,127,0.25); display: grid; grid-template-columns: minmax(0,1fr); gap: 8px; align-items: end; }
      .composerBtns { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .feedbackBar { grid-column: 1 / -1; display: none; gap: 8px; align-items: center; padding: 8px 10px; border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; background: rgba(127,127,127,0.06); }
      .feedbackBar.on { display: grid; grid-template-columns: auto minmax(0,1fr); }
      .feedbackBar .fbTitle { font-size: 12px; opacity: 0.85; margin-right: 6px; white-space: nowrap; }
      .feedbackBar .fbBtns { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .feedbackBar .fbBtns button { padding: 6px 10px; font-size: 12px; }
      .feedbackBar .fbOpts { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; opacity: 0.9; }
      .feedbackBar label { display: inline-flex; gap: 6px; align-items: center; }
      .feedbackBar input[type=""checkbox""] { width: auto; }
      .feedbackBar input[type=""text""] { padding: 8px 10px; font-size: 12px; min-width: 220px; flex: 1; }
      .attachStrip { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; background: rgba(127,127,127,0.06); }
      .attachStrip:empty { display: none; }
      .attachStrip .stripBtn { padding: 6px 10px; font-size: 12px; }
      .voiceLive { display: none; min-height: 24px; padding: 7px 10px; border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; background: rgba(127,127,127,0.06); color: inherit; font-size: 12px; line-height: 1.35; white-space: pre-wrap; }
      .voiceLive.on { display: block; }
      .voiceLive .muted { opacity: 0.7; }
      .attachItem { display:flex; gap: 6px; align-items:center; padding: 4px 8px; border: 1px solid rgba(127,127,127,0.25); border-radius: 999px; font-size: 12px; max-width: 100%; }
      .attachItem .name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .attachItem .meta { opacity: 0.75; font-size: 12px; }
      .attachItem button { padding: 4px 8px; font-size: 12px; }
      input, textarea { width: 100%; padding: 10px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.35); background: transparent; font: inherit; }
      textarea { min-height: 44px; max-height: 140px; resize: vertical; overflow: auto; white-space: pre-wrap; }
      button { padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.35); background: rgba(127,127,127,0.12); cursor: pointer; }
      button:hover { background: rgba(127,127,127,0.18); }
      button.icon { padding: 9px 10px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
      button.icon svg { width: 16px; height: 16px; fill: currentColor; }
      button:disabled { opacity: 0.55; cursor: default; }
      .badge { padding: 3px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.35); background: rgba(127,127,127,0.10); font-size: 12px; opacity: 0.9; }
      .badge.on { background: rgba(40,160,80,0.18); border-color: rgba(40,160,80,0.45); }
      .badge.warn { background: rgba(200,120,20,0.18); border-color: rgba(200,120,20,0.45); }
      .err { color: #b00020; }
      details { margin-top: 0; }
      summary { cursor: pointer; user-select: none; }
      .tools { margin-top: 6px; display: grid; gap: 6px; }
      .tool { border: 1px solid rgba(127,127,127,0.2); border-radius: 8px; padding: 8px 10px; }
      .tool .hdr { display:flex; justify-content: space-between; gap: 8px; align-items: baseline; }
      .tool .name { font-weight: 600; }
      .tool .risk { font-size: 12px; opacity: 0.75; }
      .tool .path { font-family: ui-monospace, Consolas, monospace; font-size: 12px; opacity: 0.9; margin-top: 4px; }
      .tool .desc { font-size: 12px; opacity: 0.85; margin-top: 4px; white-space: pre-wrap; }
      .tool .row { display:flex; justify-content: space-between; gap: 8px; align-items: center; margin-top: 6px; }
      .tool .row button { padding: 6px 10px; }
      .toolGroup { border: 1px solid rgba(127,127,127,0.18); border-radius: 10px; padding: 8px 10px; }
      .toolGroup summary { font-size: 12px; opacity: 0.85; }
      .micOn { background: rgba(200,60,60,0.22); border-color: rgba(200,60,60,0.45); }
      .micBusy { opacity: 0.6; cursor: default; }
      .toolsDetails { border-top: 1px solid rgba(127,127,127,0.25); }
      .toolsDetails summary { padding: 10px 12px; font-size: 12px; opacity: 0.85; }
      .toolsDetails .paneScroll { max-height: 260px; }
      .cloudForm { display: grid; gap: 8px; }
      .cloudRow { display: grid; gap: 4px; }
      .cloudRow .lbl { font-size: 12px; opacity: 0.85; }
      .cloudRow input { padding: 8px 10px; font-size: 12px; }
      .cloudRow select { padding: 6px 8px; font-size: 12px; }
      .cloudBtns { display:flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .cloudBtns button { padding: 6px 10px; font-size: 12px; }
      .cloudStatus { font-size: 12px; opacity: 0.85; white-space: pre-wrap; }
      .authStatusLine { font-size: 12px; opacity: 0.9; white-space: pre-wrap; }

      @media (max-width: 1200px) {
        .main { grid-template-columns: minmax(0,1fr) minmax(200px,36%); }
        .composerBtns { justify-content: flex-start; }
        .feedbackBar .fbTitle { width: auto; margin-right: 0; }
        .feedbackBar .fbOpts, .feedbackBar input[type=""text""] { grid-column: 1 / -1; }
        .feedbackBar input[type=""text""] { min-width: 0; width: 100%; }
      }

      @media (max-width: 780px) {
        .main { grid-template-columns: 1fr; grid-template-rows: minmax(0,1fr) auto; }
        .right { border-left: none; border-top: 1px solid rgba(127,127,127,0.25); max-height: 42vh; }
        #actionsScroll { max-height: 38vh; }
      }

      :root {
        color-scheme: light;
        --bg: #eef4fb;
        --bg2: #f8fbff;
        --surface: rgba(255,255,255,0.86);
        --surfaceStrong: rgba(255,255,255,0.97);
        --lineSoft: rgba(24,57,92,0.1);
        --lineStrong: rgba(24,57,92,0.18);
        --textStrong: #18395c;
        --textMuted: #69809a;
        --textSoft: #4b6582;
        --blue: #346fdf;
        --blueSoft: rgba(52,111,223,0.14);
        --green: #238a58;
        --greenSoft: rgba(35,138,88,0.15);
        --amber: #b67a1d;
        --amberSoft: rgba(182,122,29,0.16);
        --red: #b35646;
        --redSoft: rgba(179,86,70,0.16);
        --shadowLg: 0 18px 40px rgba(44,77,123,0.12);
        --shadowSm: 0 10px 22px rgba(44,77,123,0.08);
      }
      body {
        min-height: 100vh;
        color: var(--textStrong);
        font-family: Aptos, 'Segoe UI Variable', 'Segoe UI', Arial, sans-serif;
        background:
          radial-gradient(circle at top right, rgba(175, 227, 204, 0.3), transparent 34%),
          radial-gradient(circle at top left, rgba(164, 206, 255, 0.35), transparent 36%),
          linear-gradient(180deg, var(--bg2), var(--bg));
      }
      .wrap { position: relative; gap: 10px; padding: 12px; overflow: hidden; }
      .wrap::before, .wrap::after { content: ''; position: absolute; border-radius: 999px; filter: blur(18px); pointer-events: none; opacity: 0.7; }
      .wrap::before { width: 220px; height: 220px; right: -70px; top: 90px; background: rgba(126,194,255,0.22); }
      .wrap::after { width: 180px; height: 180px; left: -60px; bottom: 42px; background: rgba(177,232,203,0.18); }
      .top { padding: 0; border-bottom: none; position: relative; z-index: 1; }
      .bar {
        gap: 10px;
        padding: 12px 14px;
        border: 1px solid var(--lineSoft);
        border-radius: 22px;
        background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(244,248,255,0.88));
        box-shadow: var(--shadowSm);
      }
      .title { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .brandMark { width: 16px; height: 16px; border-radius: 999px; background: linear-gradient(135deg, #6aaeff, #3777e8); box-shadow: 0 0 0 4px rgba(52,111,223,0.12); flex: 0 0 auto; }
      .titleCopy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .titleName { font-size: 18px; line-height: 1; letter-spacing: -0.02em; font-weight: 700; }
      .titleMeta { font-size: 10px; color: var(--textMuted); letter-spacing: 0.14em; text-transform: uppercase; font-weight: 800; }
      .policy {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        padding: 3px 6px 3px 8px;
        border: 1px solid var(--lineSoft);
        border-radius: 999px;
        background: rgba(240,246,255,0.86);
        opacity: 1;
        flex: 0 1 auto;
        min-width: 0;
      }
      .policy span { font-size: 11px; color: var(--textMuted); letter-spacing: 0.12em; text-transform: uppercase; font-weight: 800; }
      .policy select { width: auto; min-width: 92px; }
      .main { position: relative; z-index: 1; gap: 10px; grid-template-columns: minmax(0,1fr) minmax(180px,26%); }
      .chatPane, .right {
        border: 1px solid var(--lineSoft);
        border-radius: 26px;
        background: var(--surface);
        backdrop-filter: blur(12px);
        box-shadow: var(--shadowLg);
      }
      .chatPane { overflow: hidden; }
      .right { border-left: 1px solid var(--lineSoft); padding: 10px; gap: 10px; }
      .paneScroll { padding: 14px; }
      #chatScroll { flex: 1; background: radial-gradient(circle at top right, rgba(112,176,255,0.08), transparent 28%); }
      #actionsScroll {
        flex: 1 1 0;
        min-height: 0;
        border: 1px solid var(--lineSoft);
        border-radius: 20px;
        background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(246,250,255,0.9));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.82);
      }
      .paneIntro, .paneHeader { display: grid; gap: 4px; margin-bottom: 12px; }
      .paneKicker { font-size: 11px; line-height: 1; letter-spacing: 0.18em; text-transform: uppercase; color: var(--textMuted); font-weight: 800; }
      .paneTitle { font-size: 20px; line-height: 1.1; letter-spacing: -0.03em; font-weight: 700; }
      .paneNote { max-width: 460px; font-size: 12px; color: var(--textSoft); }
      .compactPaneNote { margin-bottom: 10px; }
      .msg { margin: 0 0 14px; gap: 6px; }
      .role {
        margin: 0;
        font-size: 11px;
        color: var(--textMuted);
        letter-spacing: 0.16em;
        text-transform: uppercase;
        font-weight: 800;
      }
      .role .roleText { display: inline-flex; align-items: center; gap: 8px; }
      .msg .roleText::before { content: ''; width: 9px; height: 9px; border-radius: 999px; flex: 0 0 auto; }
      .msg.assistant .roleText::before { background: linear-gradient(135deg, #70b4ff, #4078e9); }
      .msg.user .roleText::before { background: linear-gradient(135deg, #95c4ff, #5e91ef); }
      .bubble {
        max-width: 92%;
        padding: 16px 18px;
        border-radius: 22px;
        border: 1px solid var(--lineSoft);
        background: linear-gradient(180deg, var(--surfaceStrong), rgba(247,250,255,0.96));
        box-shadow: var(--shadowSm);
        line-height: 1.55;
      }
      .msg.user .bubble { background: linear-gradient(180deg, rgba(235,244,255,0.99), rgba(218,235,255,0.96)); border-color: rgba(52,111,223,0.18); }
      .bubble .inlineCode { border-color: rgba(52,111,223,0.14); background: rgba(52,111,223,0.08); }
      .bubble .codeBlock, .action pre { padding: 12px 14px; border-radius: 16px; border-color: rgba(24,57,92,0.08); background: #f3f7fd; line-height: 1.55; }
      .event, .action, .tool, .toolGroup {
        border: 1px solid var(--lineSoft);
        background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(246,249,255,0.94));
        box-shadow: var(--shadowSm);
      }
      .event { margin: 0 0 10px; padding: 12px 14px; border-radius: 18px; color: var(--textSoft); line-height: 1.5; }
      .action { position: relative; overflow: hidden; margin: 0 0 12px; padding: 16px; border-radius: 22px; }
      .action::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 4px; background: rgba(104,128,155,0.26); }
      .action.action-running::before { background: var(--blue); }
      .action.action-done::before { background: var(--green); }
      .action.action-warning::before { background: var(--amber); }
      .action.action-error::before { background: var(--red); }
      .action.action-running { border-color: rgba(52,111,223,0.18); background: linear-gradient(180deg, rgba(255,255,255,0.99), rgba(243,247,255,0.96)); }
      .action.action-done { border-color: rgba(35,138,88,0.18); background: linear-gradient(180deg, rgba(255,255,255,0.99), rgba(244,252,247,0.96)); }
      .action.action-warning { border-color: rgba(182,122,29,0.18); background: linear-gradient(180deg, rgba(255,255,255,0.99), rgba(255,249,241,0.96)); }
      .action.action-error { border-color: rgba(179,86,70,0.2); background: linear-gradient(180deg, rgba(255,255,255,0.99), rgba(255,245,243,0.97)); }
      .action .hdr { align-items: flex-start; gap: 10px; }
      .action .title { font-size: 15px; line-height: 1.35; font-weight: 700; letter-spacing: -0.01em; }
      .action .path, .action .summary, .tool .path, .tool .desc, .cloudStatus, .authStatusLine { color: var(--textSoft); }
      .action .summary { margin-top: 10px; font-size: 13px; }
      .composer {
        gap: 10px;
        margin-top: 0;
        padding: 12px 14px 14px;
        border-top: 1px solid var(--lineSoft);
        background: linear-gradient(180deg, rgba(246,249,255,0.82), rgba(241,246,255,0.98));
      }
      .feedbackBar, .attachStrip {
        border-radius: 18px;
        border-color: rgba(52,111,223,0.14);
        background: linear-gradient(180deg, rgba(255,255,255,0.94), rgba(241,246,255,0.95));
      }
      .voiceLive {
        border-radius: 18px;
        border-color: rgba(52,111,223,0.14);
        background: linear-gradient(180deg, rgba(255,255,255,0.94), rgba(241,246,255,0.95));
        color: var(--textSoft);
      }
      .feedbackBar { padding: 8px 10px; gap: 8px; }
      .feedbackBar .fbTitle { font-size: 11px; color: var(--textMuted); letter-spacing: 0.12em; text-transform: uppercase; font-weight: 800; }
      .feedbackBar .fbBtns button { padding: 5px 8px; font-size: 12px; }
      .feedbackBar .fbOpts { gap: 8px; font-size: 11px; }
      .feedbackBar input[type=""text""] { min-width: 140px; padding: 7px 9px; font-size: 12px; }
      .attachStrip { gap: 8px; padding: 8px 10px; }
      .attachItem { gap: 8px; padding: 7px 10px; border-color: rgba(52,111,223,0.14); background: rgba(52,111,223,0.07); }
      button, select, input, textarea {
        color: var(--textStrong);
        border-color: var(--lineStrong);
        background: rgba(255,255,255,0.9);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.82);
      }
      textarea { min-height: 72px; max-height: 120px; }
      button {
        border-radius: 12px;
        background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(242,246,252,0.96));
        transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
      }
      button:hover:not(:disabled) {
        transform: translateY(-1px);
        border-color: rgba(52,111,223,0.2);
        background: linear-gradient(180deg, rgba(255,255,255,1), rgba(236,244,255,0.98));
        box-shadow: 0 8px 18px rgba(52,111,223,0.08);
      }
      #send { color: #fff; border-color: rgba(52,111,223,0.34); background: linear-gradient(135deg, #346fdf, #4d86f1); box-shadow: 0 12px 22px rgba(52,111,223,0.2); }
      #cancel, .micOn { color: var(--red); border-color: rgba(179,86,70,0.18); background: linear-gradient(180deg, rgba(255,246,244,0.98), rgba(255,241,239,0.96)); }
      #newChat, .policy { border-radius: 999px; }
      .badge, .statusPill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        font-weight: 800;
        white-space: nowrap;
      }
      .badge::before, .statusPill::before { content: ''; width: 7px; height: 7px; border-radius: 999px; background: currentColor; opacity: 0.9; }
      .statusPill { border: 1px solid transparent; }
      .statusPill.busy { box-shadow: 0 10px 18px rgba(52,111,223,0.12); }
      .statusDots { display: none; align-items: flex-end; gap: 3px; min-width: 18px; height: 10px; }
      .statusPill.busy .statusDots { display: inline-flex; }
      .statusDots span {
        width: 4px;
        height: 4px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.25;
        animation: statusDots 1.1s infinite ease-in-out;
      }
      .statusDots span:nth-child(2) { animation-delay: 0.15s; }
      .statusDots span:nth-child(3) { animation-delay: 0.3s; }
      .tone-neutral { color: #6a819c; background: rgba(106,129,156,0.12); border-color: rgba(106,129,156,0.18); }
      .tone-info { color: var(--blue); background: var(--blueSoft); border-color: rgba(52,111,223,0.18); }
      .tone-positive, .badge.on { color: var(--green); background: var(--greenSoft); border-color: rgba(35,138,88,0.18); }
      .tone-warning, .badge.warn { color: var(--amber); background: var(--amberSoft); border-color: rgba(182,122,29,0.18); }
      .tone-danger, .err { color: var(--red); background: var(--redSoft); border-color: rgba(179,86,70,0.2); }
      @keyframes statusDots {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.25; }
        40% { transform: translateY(-3px); opacity: 0.95; }
      }
      .toolsDetails { flex: 0 0 auto; border: 1px solid var(--lineSoft); border-radius: 20px; background: linear-gradient(180deg, rgba(249,251,255,0.92), rgba(243,247,255,0.88)); box-shadow: var(--shadowSm); }
      .toolsDetails summary { padding: 12px 16px; font-size: 11px; color: var(--textMuted); letter-spacing: 0.14em; text-transform: uppercase; font-weight: 800; }
      .toolsDetails[open] summary { border-bottom: 1px solid var(--lineSoft); }
      .toolsDetails .paneScroll { padding: 14px 16px 16px; }
      .actionsDetails[open] { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .actionsDetails[open] #actionsScroll { flex: 1; min-height: 0; overflow: auto; }
      .actionsDetails:not([open]) { flex: 0 0 auto; }
      .tool { border-radius: 16px; }
      .tool .risk, .cloudRow .lbl { font-size: 11px; color: var(--textMuted); letter-spacing: 0.12em; text-transform: uppercase; font-weight: 800; }
      @media (max-width: 1280px) {
        .main { grid-template-columns: minmax(0,1fr) minmax(170px,24%); }
        .paneTitle { font-size: 19px; }
      }
      @media (max-width: 1080px) {
        .wrap { padding: 10px; gap: 8px; }
        .bar { padding: 10px 12px; }
        .titleMeta { display: none; }
        .controls { flex-basis: 100%; justify-items: stretch; }
        .controlRowPrimary { justify-content: space-between; }
        .controlRowPolicies { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); }
        .policy { width: 100%; justify-content: space-between; }
        .policy span, .badge, .statusPill { letter-spacing: 0.1em; }
        .main { grid-template-columns: minmax(0,1fr) minmax(150px,22%); }
        .right { border-left: 1px solid var(--lineSoft); border-top: none; padding: 10px; gap: 10px; }
        .paneScroll { padding: 12px; }
        .composer { padding: 10px 12px 12px; }
        #chatScroll .paneKicker, #chatScroll .paneNote { display: none; }
        #chatScroll .paneIntro { margin-bottom: 8px; }
        #actionsScroll { max-height: none; }
      }
      @media (max-width: 780px) {
        .bar { align-items: flex-start; }
        .controls { justify-items: stretch; }
        .controlRowPrimary { justify-content: flex-start; }
        .controlRowPolicies { grid-template-columns: 1fr; }
        .main {
          grid-template-columns: 1fr;
          grid-template-rows: minmax(0,1fr) clamp(180px, 26vh, 240px);
        }
        .chatPane { min-height: 52vh; }
        .right {
          border-left: none;
          border-top: 1px solid var(--lineSoft);
          max-height: none;
          min-height: 0;
        }
        #actionsScroll {
          min-height: 0;
          max-height: none;
        }
      }
      @media (max-width: 760px) {
        .wrap { padding: 8px; gap: 8px; }
        .bar { padding: 10px; }
        .controls { width: 100%; }
        .paneScroll, .composer { padding-left: 14px; padding-right: 14px; }
        .bubble { max-width: 100%; }
        .feedbackBar, .feedbackBar .fbOpts { flex-wrap: wrap; }
        .feedbackBar input[type=""text""] { min-width: 0; width: 100%; }
        .policy { width: 100%; justify-content: space-between; }
      }
      @media (max-height: 920px) {
        .wrap { gap: 8px; padding: 10px; }
        .bar { padding: 10px 12px; }
        .paneIntro { margin-bottom: 8px; }
        #chatScroll .paneKicker, #chatScroll .paneNote { display: none; }
        .composer { gap: 8px; padding: 10px 12px 12px; }
        .feedbackBar.on { grid-template-columns: 1fr; }
        .feedbackBar .fbBtns, .feedbackBar .fbOpts, .feedbackBar input[type=""text""] { grid-column: 1 / -1; }
        textarea { min-height: 60px; }
      }

      /* Mockup-aligned pane refresh: same language as sidecar, compressed for docked Revit use. */
      :root {
        --bg: #fbfcff;
        --bg2: #fbfcff;
        --surface: #ffffff;
        --surfaceStrong: #ffffff;
        --lineSoft: #dfe6f1;
        --lineStrong: #cfd9e8;
        --textStrong: #17233d;
        --textMuted: #687897;
        --textSoft: #465875;
        --blue: #3d7cf4;
        --blueSoft: #eef5ff;
        --green: #42a56f;
        --greenSoft: #edf9f2;
        --amber: #d38300;
        --amberSoft: #fff7e8;
        --red: #cf3f4a;
        --redSoft: #fff0f1;
        --shadowLg: none;
        --shadowSm: none;
      }
      body { background: var(--bg); }
      .wrap { gap: 10px; padding: 12px; background: var(--bg); }
      .wrap::before, .wrap::after { display: none; }
      .bar {
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
      }
      .title { gap: 10px; }
      .brandMark {
        position: relative;
        width: 34px;
        height: 34px;
        border-radius: 8px;
        background: var(--blue);
        box-shadow: none;
      }
      .brandMark::before, .brandMark::after {
        content: '';
        position: absolute;
        left: 50%;
        top: 50%;
        width: 18px;
        height: 18px;
        background: #ffffff;
        clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%);
        transform: translate(-50%, -50%);
      }
      .brandMark::after { display: none; }
      .titleCopy { gap: 2px; }
      .titleName { font-size: 19px; letter-spacing: 0; }
      .titleMeta, .paneKicker, .role, .badge, .statusPill, .policy span, .tool .risk, .cloudRow .lbl, .feedbackBar .fbTitle {
        letter-spacing: 0;
        text-transform: none;
      }
      .titleMeta { font-size: 12px; font-weight: 500; }
      .controls { gap: 6px; flex: 1 1 360px; }
      .controlRow { gap: 6px; }
      .controlRowPrimary { order: 2; }
      .controlRowPolicies { order: 1; }
      .policy { padding: 0; border: 0; background: transparent; }
      .policy span { color: var(--textMuted); font-size: 12px; font-weight: 600; }
      button, select, input, textarea {
        border-radius: 8px;
        border-color: var(--lineSoft);
        background: #ffffff;
        box-shadow: none;
      }
      button {
        min-height: 34px;
        padding: 0 10px;
        background: #ffffff;
      }
      button:hover:not(:disabled) {
        transform: none;
        border-color: var(--lineStrong);
        background: #f8fbff;
        box-shadow: none;
      }
      #send { color: #ffffff; border-color: var(--blue); background: var(--blue); box-shadow: none; }
      #newChat, .policy, .badge, .statusPill { border-radius: 8px; }
      .badge, .statusPill {
        min-height: 34px;
        padding: 0 10px;
        font-size: 12px;
        font-weight: 600;
        background: #ffffff;
      }
      .badge::before, .statusPill::before { width: 8px; height: 8px; }
      .tone-neutral { color: var(--textSoft); background: #ffffff; border-color: var(--lineSoft); }
      .tone-info { color: var(--textStrong); background: #f4f7ff; border-color: #dce5fb; }
      .tone-positive, .badge.on { color: #1d7449; background: var(--greenSoft); border-color: #cbead8; }
      .tone-warning, .badge.warn { color: #835200; background: var(--amberSoft); border-color: #f1d49b; }
      .tone-danger, .err { color: #a52833; background: var(--redSoft); border-color: #f1c3c8; }
      .main { gap: 10px; grid-template-columns: minmax(0,1fr) minmax(190px,28%); }
      .chatPane, .right, .toolsDetails {
        border: 1px solid var(--lineSoft);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: none;
        backdrop-filter: none;
      }
      .right { padding: 10px; gap: 10px; border-left: 1px solid var(--lineSoft); }
      .eventsPane {
        display: block;
        border: 1px solid var(--lineSoft);
        border-radius: 8px;
        background: #ffffff;
        max-height: 180px !important;
      }
      .eventsPane .role { margin-bottom: 8px; color: var(--textStrong); font-size: 14px; font-weight: 700; }
      #events { position: relative; padding-left: 18px; }
      #events::before {
        content: '';
        position: absolute;
        left: 6px;
        top: 6px;
        bottom: 6px;
        width: 2px;
        background: #d8e0eb;
      }
      .event {
        position: relative;
        margin: 0 0 8px;
        padding: 8px 10px;
        border-radius: 8px;
        color: var(--textSoft);
        background: #ffffff;
        box-shadow: none;
      }
      .event::before {
        content: '';
        position: absolute;
        left: -17px;
        top: 14px;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #aab4c2;
        box-shadow: 0 0 0 3px #ffffff;
      }
      #chatScroll { background: #ffffff; }
      .paneScroll { padding: 14px; }
      .paneIntro { display: none; }
      .msg { margin: 0 0 16px; }
      .role { color: var(--textMuted); font-size: 12px; font-weight: 600; }
      .msg .roleText::before { display: none; }
      .bubble {
        max-width: 92%;
        padding: 12px 14px;
        border-radius: 8px;
        border-color: var(--lineSoft);
        background: #ffffff;
        box-shadow: none;
        line-height: 1.5;
      }
      .msg.user .bubble { background: #eaf2ff; border-color: #d7e6ff; }
      .action, .tool, .toolGroup, .feedbackBar, .attachStrip {
        border-radius: 8px;
        border-color: var(--lineSoft);
        background: #ffffff;
        box-shadow: none;
      }
      .action { padding: 12px; }
      .action::before { width: 3px; }
      .action .title { font-size: 13px; letter-spacing: 0; }
      .composer {
        gap: 8px;
        padding: 12px;
        border-top: 1px solid var(--lineSoft);
        background: #ffffff;
      }
      textarea {
        min-height: 58px;
        max-height: 110px;
        border: 0;
        resize: none;
        box-shadow: none;
      }
      textarea:focus { outline: none; }
      @media (max-width: 1080px) {
        .main { grid-template-columns: minmax(0,1fr) minmax(170px,26%); }
        .right { padding: 8px; }
      }
      @media (max-width: 780px) {
        .main { grid-template-columns: 1fr; grid-template-rows: minmax(72px,1fr) clamp(140px, 24vh, 200px); }
        .chatPane { min-height: 0; }
        .composer {
          grid-template-columns: minmax(0,1fr) auto;
          align-items: center;
          padding: 8px;
        }
        .composerBtns {
          flex-wrap: nowrap;
          justify-content: flex-end;
          gap: 4px;
        }
        textarea { min-height: 44px; max-height: 72px; }
      }
    </style>
  </head>
  <body>
    <div class=""wrap"">
      <div class=""top"">
        <div class=""bar"">
          <div class=""title"">
            <div class=""brandMark"" aria-hidden=""true""></div>
            <div class=""titleCopy"">
              <div class=""titleName"">Operator</div>
              <div class=""titleMeta"">Revit Native</div>
            </div>
          </div>
          <div class=""controls"">
            <div class=""controlRow controlRowPrimary"">
              <button id=""newChat"" title=""Start a new chat session"">New chat</button>
              <div id=""grantBadge"" class=""badge tone-neutral"" title=""Bridge-layer write grant status (required for MCP writes)"">Grant: off</div>
              <div id=""authBadge"" class=""badge tone-warning"" title=""Operator authentication status"">Auth: required</div>
            </div>
            <div class=""controlRow controlRowPolicies"">
              <div class=""policy"">
                <span>Writes:</span>
                <select id=""policy"">
                  <option value=""safe"">Approve</option>
                  <option value=""session"">Allow this session</option>
                  <option value=""yolo"" selected>YOLO</option>
                </select>
              </div>
              <div class=""policy"">
                <span>Native API:</span>
                <select id=""nativeApiPolicy"" title=""Native Revit API gateway profile"">
                  <option value=""balanced"">Balanced</option>
                  <option value=""broad"" selected>Broad</option>
                  <option value=""unrestricted"">Unrestricted</option>
                </select>
              </div>
              <div class=""policy"">
                <span>Brain:</span>
                <select id=""brainRoute"" title=""Configured direct uses the hosted agent harness; Auto pipeline keeps the legacy deterministic router available as a fallback."">
                  <option value=""auto"">Auto pipeline</option>
                  <option value=""direct"" selected>Configured direct</option>
                </select>
              </div>
            </div>
            <div class=""policy"">
              <span>Reasoning:</span>
              <select id=""reasoning"" title=""Lower effort is faster; higher effort spends more time reasoning before responding."">
                <option value=""low"">Fast</option>
                <option value=""medium"" selected>Balanced</option>
                <option value=""high"">Deep</option>
                <option value=""xhigh"">Max</option>
              </select>
            </div>
            <div class=""controlRow controlRowPolicies"">
              <label class=""policy"" title=""Route simple commands through the fast executor model."">
                <span>Speed:</span>
                <input id=""speedMode"" type=""checkbox"">
              </label>
              <label class=""policy"" title=""Send a smaller Revit context and shorter tool summaries."">
                <span>Diet:</span>
                <input id=""speedDiet"" type=""checkbox"">
              </label>
            </div>
            <div class=""controlRow controlRowPolicies"">
              <div class=""policy"">
                <span>Planner:</span>
                <select id=""speedPlanner"" title=""Model for ambiguous, visual, failed, or planning-heavy turns."">
                  <option value=""gpt-5.6-sol"" selected>GPT-5.6 Sol</option>
                  <option value=""gpt-5.6-terra"">GPT-5.6 Terra</option>
                </select>
              </div>
              <div class=""policy"">
                <span>Exec:</span>
                <select id=""speedExecutor"" title=""Model for direct commands and tool-loop continuations."">
                  <option value=""gpt-5.6-terra"" selected>GPT-5.6 Terra</option>
                  <option value=""gpt-5.6-sol"">GPT-5.6 Sol</option>
                </select>
              </div>
            </div>
            <div id=""runStatus"" class=""statusPill tone-neutral"" title=""Current run status"">
              <span id=""runStatusLabel"">Idle</span>
              <span class=""statusDots"" aria-hidden=""true""><span></span><span></span><span></span></span>
            </div>
          </div>
        </div>
      </div>
      <div class=""main"">
        <div class=""left"">
          <div class=""chatPane"">
            <div id=""chatScroll"" class=""paneScroll"">
              <div class=""paneIntro"">
                <div class=""paneKicker"">Operator</div>
                <div class=""paneTitle"">Conversation</div>
                <div class=""paneNote"">Describe the model update, review task, or drawing change you want inside Revit.</div>
              </div>
              <div id=""msgs""></div>
            </div>
            <div class=""composer"">
              <div id=""attachStrip"" class=""attachStrip""></div>
              <div id=""voiceLive"" class=""voiceLive"" aria-live=""polite""></div>
              <div id=""feedbackBar"" class=""feedbackBar"" title=""Optional: send feedback for the last run"">
                <div class=""fbTitle"">Feedback:</div>
                <div class=""fbBtns"">
                  <button id=""fbWorked"" title=""Mark as worked"">Worked</button>
                  <button id=""fbPartial"" title=""Mark as partially worked"">Partial</button>
                  <button id=""fbFailed"" title=""Mark as failed"">Failed</button>
                </div>
                <div class=""fbOpts"">
                  <label><input id=""fbRemember"" type=""checkbox"" /> Remember preference</label>
                  <label><input id=""fbQueue"" type=""checkbox"" /> Queue upload</label>
                  <label><input id=""fbDevApply"" type=""checkbox"" /> Dev: auto-update repo</label>
                </div>
                <input id=""fbNote"" type=""text"" placeholder=""Optional note / preference to remember"" />
              </div>
              <textarea id=""text"" rows=""2"" placeholder=""Tell Operator what to do inside Revit."" ></textarea>
              <div class=""composerBtns"">
                <button id=""attach"" class=""icon"" title=""Attach file(s) from your computer"" aria-label=""Attach files"">
                  <svg viewBox=""0 0 24 24"" aria-hidden=""true""><path d=""M16.5 6.5l-7.8 7.8a3 3 0 104.2 4.2l7.1-7.1a5 5 0 10-7.1-7.1l-7.4 7.4a7 7 0 109.9 9.9l6.6-6.6-1.4-1.4-6.6 6.6a5 5 0 11-7.1-7.1l7.4-7.4a3 3 0 114.2 4.2l-7.1 7.1a1 1 0 11-1.4-1.4l7.8-7.8 1.4 1.4z""/></svg>
                </button>
                <button id=""screen"" class=""icon"" title=""Share screen: capture a Revit-window screenshot and attach it"" aria-label=""Share screen"">
                  <svg viewBox=""0 0 24 24"" aria-hidden=""true""><path d=""M4 6h16a2 2 0 012 2v8a2 2 0 01-2 2H14l2 2v1H8v-1l2-2H4a2 2 0 01-2-2V8a2 2 0 012-2zm0 2v8h16V8H4zm8 1.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zm0 2a1.5 1.5 0 100 3 1.5 1.5 0 000-3z""/></svg>
                </button>
                <button id=""recStart"" class=""icon"" title=""Start voice dictation"" aria-label=""Start recording"">
                  <svg viewBox=""0 0 24 24"" aria-hidden=""true""><path d=""M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V21h2v-3.08A7 7 0 0019 11h-2z""/></svg>
                </button>
                <button id=""recStop"" class=""icon"" title=""Stop voice dictation"" aria-label=""Stop recording"" disabled>
                  <svg viewBox=""0 0 24 24"" aria-hidden=""true""><path d=""M7 7h10v10H7V7z""/></svg>
                </button>
                <button id=""cancel"" class=""icon"" title=""Cancel the current operator run"" aria-label=""Cancel"" disabled>
                  <svg viewBox=""0 0 24 24"" aria-hidden=""true""><path d=""M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4z""/></svg>
                </button>
                <button id=""send"" class=""icon"" title=""Send message"" aria-label=""Send"">
                  <svg viewBox=""0 0 24 24"" aria-hidden=""true""><path d=""M2 21l21-9L2 3v7l15 2-15 2v7z""/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class=""right"">
          <div class=""paneScroll eventsPane"" style=""max-height: 220px"">
            <div class=""role"">Run activity</div>
            <div id=""events""></div>
          </div>
          <details id=""actionsDetails"" class=""toolsDetails actionsDetails"" open>
            <summary>Actions</summary>
            <div id=""actionsScroll"" class=""paneScroll"">
              <div id=""actions""></div>
            </div>
          </details>
          <details id=""authDetails"" class=""toolsDetails"">
            <summary>Auth</summary>
            <div class=""paneScroll"">
              <div class=""cloudForm"">
                <div class=""cloudRow"">
                  <div class=""lbl"">Mode / endpoint</div>
                  <div id=""authModeInfo"" class=""authStatusLine"">Mode: none</div>
                </div>
                <div class=""cloudRow"">
                  <div class=""lbl"">Current state</div>
                  <div id=""authStateInfo"" class=""authStatusLine"">Not signed in.</div>
                </div>
                <div class=""cloudRow"">
                  <div class=""lbl"">Email</div>
                  <input id=""authEmail"" type=""email"" placeholder=""you@company.com"" />
                </div>
                <div class=""cloudRow"">
                  <div class=""lbl"">Password</div>
                  <input id=""authPassword"" type=""password"" placeholder=""Password"" />
                </div>
                <div class=""cloudBtns"">
                  <button id=""authLogin"">Sign in</button>
                  <button id=""authRefresh"">Refresh token</button>
                  <button id=""authSignOut"">Sign out</button>
                </div>
                <div id=""authMessage"" class=""cloudStatus""></div>
              </div>
            </div>
          </details>
          <details id=""cloudDetails"" class=""toolsDetails"">
            <summary>Cloud</summary>
            <div class=""paneScroll"">
              <div class=""cloudForm"">
                <div class=""cloudRow"">
                  <div class=""lbl"">Improvement upload URL</div>
                  <input id=""cloudUrl"" type=""text"" placeholder=""https://example.invalid/revitoperator/improvements/ingest"" />
                </div>
                <div class=""cloudRow"">
                  <div class=""lbl"">Bearer token (leave blank to keep saved token)</div>
                  <input id=""cloudToken"" type=""password"" placeholder=""(not shown)"" />
                </div>
                <div class=""cloudRow"">
                  <div class=""lbl"">Uploader mode</div>
                  <select id=""cloudMode"">
                    <option value=""off"">Off</option>
                    <option value=""watch"">Watch</option>
                    <option value=""once"">Once</option>
                  </select>
                </div>
                <div class=""cloudBtns"">
                  <button id=""cloudSave"">Save</button>
                  <button id=""cloudClearToken"" title=""Clear the saved token from local Workspace config"">Clear token</button>
                  <button id=""cloudRefresh"" title=""Reload current settings from the local backend"">Refresh</button>
                </div>
                <div id=""cloudStatus"" class=""cloudStatus""></div>
              </div>
            </div>
          </details>
          <details id=""attachDetails"" class=""toolsDetails"">
            <summary>Attachments</summary>
            <div class=""paneScroll"">
              <div class=""cloudForm"">
                <div class=""cloudRow"">
                  <label><input id=""attShare"" type=""checkbox"" /> Share attachments with agent</label>
                </div>
                <div class=""cloudRow"">
                  <label><input id=""attAutoOpen"" type=""checkbox"" /> Auto-include latest screenshot (opt-in)</label>
                </div>
                <div class=""cloudStatus"" style=""white-space: pre-wrap; opacity: 0.9;"">Auto-include uses the most recent file under Workspace\artifacts\uploads\ and attaches it to your next message.</div>
              </div>
            </div>
          </details>
          <details id=""toolsDetails"" class=""toolsDetails"">
            <summary>Tools</summary>
            <div class=""paneScroll"">
              <div id=""tools"" class=""tools""></div>
            </div>
          </details>
        </div>
      </div>
    </div>

    <script>
      const PROTO = ""operator.ui.v1"";
      const msgsEl = document.getElementById('msgs');
      const eventsEl = document.getElementById('events');
      const actionsEl = document.getElementById('actions');
      const toolsEl = document.getElementById('tools');
      const scrollEl = document.getElementById('chatScroll');
      const actionsScrollEl = document.getElementById('actionsScroll');
      const inputEl = document.getElementById('text');
      const attachStripEl = document.getElementById('attachStrip');
      const voiceLiveEl = document.getElementById('voiceLive');
      const attachBtn = document.getElementById('attach');
      const screenBtn = document.getElementById('screen');
      const sendBtn = document.getElementById('send');
      const recStartBtn = document.getElementById('recStart');
      const recStopBtn = document.getElementById('recStop');
      const cancelBtn = document.getElementById('cancel');
      const policySel = document.getElementById('policy');
      const nativeApiPolicySel = document.getElementById('nativeApiPolicy');
      const brainRouteSel = document.getElementById('brainRoute');
      const reasoningSel = document.getElementById('reasoning');
      const speedModeEl = document.getElementById('speedMode');
      const speedDietEl = document.getElementById('speedDiet');
      const speedPlannerEl = document.getElementById('speedPlanner');
      const speedExecutorEl = document.getElementById('speedExecutor');
      const newChatBtn = document.getElementById('newChat');
      const runStatusEl = document.getElementById('runStatus');
      const runStatusLabelEl = document.getElementById('runStatusLabel');
      const feedbackBarEl = document.getElementById('feedbackBar');
      const fbNoteEl = document.getElementById('fbNote');
      const fbRememberEl = document.getElementById('fbRemember');
      const fbQueueEl = document.getElementById('fbQueue');
      const fbDevApplyEl = document.getElementById('fbDevApply');
      const fbWorkedBtn = document.getElementById('fbWorked');
      const fbPartialBtn = document.getElementById('fbPartial');
      const fbFailedBtn = document.getElementById('fbFailed');
      const cloudUrlEl = document.getElementById('cloudUrl');
      const cloudTokenEl = document.getElementById('cloudToken');
      const cloudModeEl = document.getElementById('cloudMode');
      const cloudSaveBtn = document.getElementById('cloudSave');
      const cloudClearTokenBtn = document.getElementById('cloudClearToken');
      const cloudRefreshBtn = document.getElementById('cloudRefresh');
      const cloudStatusEl = document.getElementById('cloudStatus');
      const authDetailsEl = document.getElementById('authDetails');
      const cloudDetailsEl = document.getElementById('cloudDetails');
      const attachDetailsEl = document.getElementById('attachDetails');
      const toolsDetailsEl = document.getElementById('toolsDetails');
      const authBadgeEl = document.getElementById('authBadge');
      const authModeInfoEl = document.getElementById('authModeInfo');
      const authStateInfoEl = document.getElementById('authStateInfo');
      const authEmailEl = document.getElementById('authEmail');
      const authPasswordEl = document.getElementById('authPassword');
      const authLoginBtn = document.getElementById('authLogin');
      const authRefreshBtn = document.getElementById('authRefresh');
      const authSignOutBtn = document.getElementById('authSignOut');
      const authMessageEl = document.getElementById('authMessage');
      const attShareEl = document.getElementById('attShare');
      const attAutoOpenEl = document.getElementById('attAutoOpen');
      if (authDetailsEl) authDetailsEl.open = false;

      const actions = new Map();
      const actionState = new Map(); // actionId -> { title, path, approvalRequired, body }
      const baseBodyJsonByActionId = new Map(); // actionId -> stable JSON for exclusion rebuild
      const planSelectionByActionId = new Map(); // actionId -> Map(key->checked)
      let loopRunning = false;
      let runStatusTimer = null;
      let runStatusStartedAt = 0;
      let runStatusPhaseStartedAt = 0;
      let runStatusLastHeartbeatAt = 0;
      let runStatusPhase = 'idle';
      let runStatusActionHint = '';
      const runStatusActiveActions = new Set();
      let pendingAttachments = [];
      let lastRootMessageId = '';
      let authCanChat = true;
      let authBlockedReason = '';

      function syncRightRailLayout() {
        try {
          if (!actionsScrollEl) return;
          const rightRailEl = actionsScrollEl.parentElement;
          if (!rightRailEl) return;

          actionsScrollEl.style.flex = '1 1 0px';
          actionsScrollEl.style.minHeight = '0px';
          actionsScrollEl.style.removeProperty('height');

          const totalHeight = rightRailEl.clientHeight;
          if (!totalHeight) return;

          const visibleChildren = Array.from(rightRailEl.children).filter((child) => {
            return child instanceof HTMLElement && child.offsetParent !== null;
          });
          if (visibleChildren.length <= 1) return;

          const computed = window.getComputedStyle(rightRailEl);
          const gap = parseFloat(computed.rowGap || computed.gap || '0') || 0;
          let occupied = gap * Math.max(0, visibleChildren.length - 1);

          for (const child of visibleChildren) {
            if (child === actionsScrollEl) continue;
            occupied += child.getBoundingClientRect().height;
          }

          const available = Math.max(180, Math.floor(totalHeight - occupied));
          actionsScrollEl.style.flex = '0 1 auto';
          actionsScrollEl.style.height = available + 'px';
        } catch {}
      }

      function scrollActionsToBottom() {
        try {
          if (!actionsScrollEl) return;
          actionsScrollEl.scrollTop = actionsScrollEl.scrollHeight;
        } catch {}
      }

      function formatBytes(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v < 0) return '';
        if (v < 1024) return v + ' B';
        const kb = v / 1024;
        if (kb < 1024) return kb.toFixed(1) + ' KB';
        const mb = kb / 1024;
        if (mb < 1024) return mb.toFixed(1) + ' MB';
        const gb = mb / 1024;
        return gb.toFixed(1) + ' GB';
      }

      function renderAttachStrip() {
        if (!attachStripEl) return;
        attachStripEl.innerHTML = '';

        if (!Array.isArray(pendingAttachments) || pendingAttachments.length === 0) return;

        const openBtn = document.createElement('button');
        openBtn.className = 'stripBtn';
        openBtn.textContent = 'Open uploads';
        openBtn.title = 'Open Workspace uploads folder';
        openBtn.addEventListener('click', () => post('shell.openFolder', { path: 'artifacts/uploads' }));
        attachStripEl.appendChild(openBtn);

        for (const a of pendingAttachments) {
          const el = document.createElement('div');
          el.className = 'attachItem';

          const name = document.createElement('div');
          name.className = 'name';
          const fn = (a.filename || a.relative_path || '').toString();
          name.textContent = fn || 'attachment';
          el.appendChild(name);

          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = formatBytes(a.bytes);
          el.appendChild(meta);

          const reveal = document.createElement('button');
          reveal.textContent = 'Reveal';
          reveal.title = 'Reveal file in Explorer';
          reveal.addEventListener('click', () => {
            const p = (a.relative_path || '').toString();
            if (p) post('shell.openFolder', { path: p });
          });
          el.appendChild(reveal);

          const rm = document.createElement('button');
          rm.textContent = 'Remove';
          rm.title = 'Remove from this message (file remains in Workspace)';
          rm.addEventListener('click', () => {
            const id = (a.id || '').toString();
            pendingAttachments = pendingAttachments.filter(x => (x && typeof x === 'object') && ((x.id || '').toString() !== id));
            renderAttachStrip();
          });
          el.appendChild(rm);

          attachStripEl.appendChild(el);
        }
      }

      function displayRole(role) {
        const r = (role || '').toString().trim().toLowerCase();
        if (r === 'assistant') return 'Operator';
        if (r === 'system') return 'System';
        if (r === 'user') return 'User';
        return role || '';
      }

      function setToneClass(el, tone) {
        if (!el) return;
        el.classList.remove('tone-neutral', 'tone-info', 'tone-positive', 'tone-warning', 'tone-danger');
        el.classList.add('tone-' + (tone || 'neutral'));
      }

      function classifyStatusTone(status, error) {
        if (error) return 'danger';
        const s = (status || '').toString().trim().toLowerCase();
        if (!s) return 'neutral';
        if (s.includes('fail') || s.includes('error') || s.includes('cancel') || s.includes('denied')) return 'danger';
        if (s.includes('done') || s.includes('success') || s.includes('complete') || s.includes('approved') || s.includes('applied') || s === 'ok') return 'positive';
        if (s.includes('approval') || s.includes('confirm') || s.includes('review') || s.includes('blocked')) return 'warning';
        if (s.includes('run') || s.includes('progress') || s.includes('stream') || s.includes('plan') || s.includes('load')) return 'info';
        return 'neutral';
      }

      function applyActionState(el, status, error) {
        if (!el) return;
        el.classList.remove('action-pending', 'action-running', 'action-done', 'action-warning', 'action-error');
        const tone = classifyStatusTone(status, error);
        if (tone === 'danger') el.classList.add('action-error');
        else if (tone === 'positive') el.classList.add('action-done');
        else if (tone === 'warning') el.classList.add('action-warning');
        else if (tone === 'info') el.classList.add('action-running');
        else el.classList.add('action-pending');
        const pill = el.querySelector('.status');
        setToneClass(pill, tone);
      }

      function post(type, payload) {
        const msg = { version: PROTO, type, payload };
        window.chrome?.webview?.postMessage(msg);
      }

      function readBoolPref(key, defaultValue) {
        try {
          const v = (localStorage.getItem(key) || '').toString().trim().toLowerCase();
          if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
          if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
        } catch {}
        return !!defaultValue;
      }

      function writeBoolPref(key, value) {
        try { localStorage.setItem(key, value ? '1' : '0'); } catch {}
      }

      function readStringPref(key, defaultValue) {
        try {
          const v = (localStorage.getItem(key) || '').toString();
          if (v.trim()) return v;
        } catch {}
        return (defaultValue || '').toString();
      }

      function writeStringPref(key, value) {
        try { localStorage.setItem(key, (value || '').toString()); } catch {}
      }

      function normalizeReasoningValue(value) {
        const v = (value || '').toString().trim().toLowerCase();
        if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh') return v;
        return 'medium';
      }

      function normalizeSpeedModel(value, fallback) {
        const v = (value || '').toString().trim();
        if (v === 'gpt-5.6-sol' || v === 'gpt-5.6-terra') return v;
        return fallback;
      }

      function getSpeedSettings() {
        const speedMode = !!(speedModeEl && speedModeEl.checked);
        const contextDiet = !!(speedDietEl ? speedDietEl.checked : true);
        return {
          speed_mode: speedMode,
          split_planner_executor: true,
          planner_model: normalizeSpeedModel(speedPlannerEl ? speedPlannerEl.value : '', 'gpt-5.6-sol'),
          planner_reasoning_effort: 'medium',
          executor_model: normalizeSpeedModel(speedExecutorEl ? speedExecutorEl.value : '', 'gpt-5.6-terra'),
          executor_reasoning_effort: 'medium',
          force_planner: false,
          force_executor: false,
          context_diet: contextDiet,
          max_recent_turns: 8,
          include_full_revit_state: !contextDiet,
          include_screenshot_every_turn: false,
          verbose_tool_results: !contextDiet,
          batch_execution: false,
          persistent_session_mode: false
        };
      }

      function setRunStatus(text, tone, busy) {
        if (!runStatusEl || !runStatusLabelEl) return;
        setToneClass(runStatusEl, tone || 'neutral');
        runStatusEl.classList.toggle('busy', !!busy);
        runStatusLabelEl.textContent = (text || '').toString();
      }

      function setRunStatusPhase(phase) {
        const next = (phase || 'thinking').toString();
        if (runStatusPhase !== next) {
          runStatusPhase = next;
          runStatusPhaseStartedAt = Date.now();
        } else if (!runStatusPhaseStartedAt) {
          runStatusPhaseStartedAt = Date.now();
        }
      }

      function syncRunStatusPhaseFromActions() {
        if (!loopRunning) {
          setRunStatusPhase('idle');
          return;
        }
        if (runStatusActiveActions.size > 0) {
          setRunStatusPhase('working');
          return;
        }
        setRunStatusPhase('thinking');
      }

      function shortenRunHint(text) {
        const raw = (text || '').toString().trim();
        if (!raw) return '';
        const compact = raw.replace(/^\/revit\//i, '').replace(/^\/ui\//i, 'ui/');
        return compact.length > 28 ? compact.slice(0, 25) + '...' : compact;
      }

      function refreshRunStatus() {
        if (!loopRunning) {
          setRunStatus('Idle', 'neutral', false);
          return;
        }
        const startedAt = runStatusPhaseStartedAt || runStatusStartedAt || Date.now();
        const elapsed = Math.max(0, Date.now() - startedAt);
        let label = 'Think';
        let tone = 'info';
        if (runStatusPhase === 'working') {
          label = elapsed >= 60000 ? 'Still working' : 'Work';
        } else if (runStatusPhase === 'responding') {
          label = elapsed >= 60000 ? 'Still responding' : 'Respond';
        } else if (runStatusPhase === 'approval') {
          label = 'Waiting for approval';
          tone = 'warning';
        } else if (runStatusPhase === 'retry') {
          label = 'Recovering';
          tone = 'danger';
        } else if (elapsed >= 60000) {
          label = 'Still thinking';
        }
        if (runStatusPhase === 'thinking' && runStatusLastHeartbeatAt > 0 && Date.now() - runStatusLastHeartbeatAt > 9000 && elapsed >= 60000) {
          label = 'Still thinking';
        }
        setRunStatus(label, tone, true);
      }

      function getAttachmentPolicy() {
        const share = !!(attShareEl ? attShareEl.checked : readBoolPref('op.attShare', true));
        const autoOpen = !!(attAutoOpenEl ? attAutoOpenEl.checked : readBoolPref('op.attAutoOpenLatest', false));
        return { share_with_agent: share, auto_open_latest_attachment: share && autoOpen };
      }

      function parseMarkdownLinks(text) {
        // Minimal parser: [label](url), tolerant of line wraps between ] and (.
        const out = [];
        const s = (text || '').toString();
        let i = 0;
        while (i < s.length) {
          const lb = s.indexOf('[', i);
          if (lb < 0) { out.push({ t: 'text', v: s.slice(i) }); break; }
          const rb = s.indexOf(']', lb + 1);
          let lp = -1;
          if (rb >= 0) {
            let k = rb + 1;
            while (k < s.length && /\s/.test(s[k])) k++;
            if (s[k] === '(') lp = k;
          }
          const rp = lp >= 0 ? s.indexOf(')', lp + 1) : -1;
          const isLink = rb >= 0 && lp >= 0 && rp >= 0;

          if (!isLink) {
            out.push({ t: 'text', v: s.slice(i, lb + 1) });
            i = lb + 1;
            continue;
          }

          if (lb > i) out.push({ t: 'text', v: s.slice(i, lb) });
          const label = s.slice(lb + 1, rb);
          const url = s.slice(lp + 1, rp).trim();
          out.push({ t: 'link', label, url });
          i = rp + 1;
        }
        return out;
      }

      function encodeOpPath(path) {
        // Encode only what we must; keep forward slashes readable/stable.
        try { return encodeURIComponent((path || '').toString()).replace(/%2F/ig, '/'); } catch { return '' + (path || ''); }
      }

      function normalizeOpenFolderLinkFormatting(text) {
        // Fix common model/UI wrap artifacts around op://open-folder?path=...
        // Example: op://open-folder?path=artifacts/...
        try {
          let s = (text || '').toString();
          s = s.replace(/(op:\/\/open-folder\?|revitoperator:\/\/open-folder\?)\s*path\s*=\s*/ig, '$1path=');
          s = s.replace(/(op:\/\/open-folder\?|revitoperator:\/\/open-folder\?)\s*path\s*:\s*/ig, '$1path=');

          const prefixes = ['op://open-folder?path=', 'revitoperator://open-folder?path='];
          for (const pref of prefixes) {
            let i = 0;
            while (i < s.length) {
              const idx = s.toLowerCase().indexOf(pref, i);
              if (idx < 0) break;
              const start = idx + pref.length;
              let j = start;
              let path = '';
              while (j < s.length) {
                const c = s[j];
                const cc = c.charCodeAt(0);
                if (cc === 34 || cc === 39 || c === '<' || c === '>' || c === ')' || c === ']') break;
                if (c === '\\r' || c === '\\n') { j++; continue; }
                if (/\\s/.test(c)) {
                  let k = j;
                  while (k < s.length && /\\s/.test(s[k])) k++;
                  if (k >= s.length) break;
                  const next = s[k];
                  if (/[A-Za-z0-9._~/%+\\-]/.test(next) || next === '/') { j = k; continue; }
                  break;
                }
                if (/[A-Za-z0-9._~/%+\\-]/.test(c) || c === '/') { path += c; j++; continue; }
                break;
              }

              const before = s.slice(0, idx);
              const after = s.slice(j);
              s = before + pref + path + after;
              i = idx + pref.length + path.length;
            }
          }

          return s;
        } catch { return (text || '').toString(); }
      }

      function splitAutoLinks(text) {
        // Detect Operator UI links even when not wrapped as markdown.
        const s = normalizeOpenFolderLinkFormatting(text);
        const out = [];

        const re = /(op:\/\/open-folder\?path=[^\s<>""']+|revitoperator:\/\/open-folder\?path=[^\s<>""']+|artifacts\/[^\s<>""']+)/ig;
        let last = 0;
        let m = null;
        while ((m = re.exec(s)) !== null) {
          const idx = m.index || 0;
          if (idx > last) out.push({ t: 'text', v: s.slice(last, idx) });

          let raw = (m[0] || '').toString();
          let suffix = '';
          while (raw && /[)\].,;:!?]+$/.test(raw)) {
            suffix = raw.slice(raw.length - 1) + suffix;
            raw = raw.slice(0, raw.length - 1);
          }

          const lower = raw.toLowerCase();
          if (lower.startsWith('op://open-folder?path=') || lower.startsWith('revitoperator://open-folder?path=')) {
            out.push({ t: 'link', label: raw, url: raw });
          } else if (lower.startsWith('artifacts/')) {
            const url = 'op://open-folder?path=' + encodeOpPath(raw);
            out.push({ t: 'link', label: raw, url });
          } else {
            out.push({ t: 'text', v: raw });
          }

          if (suffix) out.push({ t: 'text', v: suffix });
          last = idx + (m[0] || '').length;
        }
        if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
        return out;
      }

      function handleLinkClick(url) {
        const raw = (url || '').toString().trim();
        if (!raw) return false;
        try {
          const u = new URL(raw);
          const proto = (u.protocol || '').toLowerCase();
          if (proto === 'op:' || proto === 'revitoperator:') {
            const host = (u.hostname || '').toLowerCase();
            if (host === 'open-folder') {
              const p = u.searchParams.get('path') || '';
              post('shell.openFolder', { path: p });
              return true;
            }
          }
          if (proto === 'file:') {
            post('shell.openPath', { path: raw });
            return true;
          }
        } catch { }

        // Fallback for unescaped spaces / non-URL-safe characters.
        try {
          const lower = raw.toLowerCase();
          const prefixes = ['op://open-folder?path=', 'revitoperator://open-folder?path='];
          for (const pref of prefixes) {
            if (!lower.startsWith(pref)) continue;
            let tail = raw.slice(pref.length);
            const amp = tail.indexOf('&');
            if (amp >= 0) tail = tail.slice(0, amp);
            const p = decodeURIComponent(tail.replace(/\+/g, ' '));
            post('shell.openFolder', { path: p });
            return true;
          }
          if (lower.startsWith('file:///')) {
            post('shell.openPath', { path: raw });
            return true;
          }
        } catch { }
        return false;
      }

      function splitCodeFences(text) {
        const s = normalizeOpenFolderLinkFormatting(text);
        const out = [];
        let i = 0;
        while (i < s.length) {
          const lb = s.indexOf('```', i);
          if (lb < 0) { out.push({ t: 'text', v: s.slice(i) }); break; }
          const rb = s.indexOf('```', lb + 3);
          if (rb < 0) { out.push({ t: 'text', v: s.slice(i) }); break; }

          if (lb > i) out.push({ t: 'text', v: s.slice(i, lb) });
          let code = s.slice(lb + 3, rb);
          if (code.startsWith('\r\n')) code = code.slice(2);
          else if (code.startsWith('\n')) code = code.slice(1);

          // Strip optional language tag line (```json\n...).
          const nl = code.indexOf('\n');
          if (nl >= 0) {
            const first = code.slice(0, nl).trim();
            if (/^[a-z0-9_+-]{1,24}$/i.test(first)) code = code.slice(nl + 1);
          }
          out.push({ t: 'code', v: code.replace(/\s+$/, '') });
          i = rb + 3;
        }
        return out;
      }

      function appendTextWithBreaks(parent, text) {
        const s = (text || '').toString();
        if (s) parent.appendChild(document.createTextNode(s));
      }

      function appendLink(parent, label, url) {
        const a = document.createElement('a');
        a.href = url;
        a.textContent = stripInlineMd(label || url);
        a.addEventListener('click', (e) => {
          if (handleLinkClick(url)) {
            e.preventDefault();
            e.stopPropagation();
          }
        });
        parent.appendChild(a);
      }

      function stripInlineMd(text) {
        try {
          const s = (text || '').toString();
          return s
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/__(.+?)__/g, '$1')
            .replace(/`(.+?)`/g, '$1');
        } catch { return (text || '').toString(); }
      }

      function renderInlineWithMd(parent, text) {
        // Supports: markdown links, raw op:// links, artifacts/... paths, **bold**, __bold__, `inline code`.
        const parts = parseMarkdownLinks(text);
        for (const p of parts) {
          if (p.t === 'link') {
            appendLink(parent, p.label || p.url, p.url);
            continue;
          }

          const split = splitAutoLinks(p.v);
          for (const s of split) {
            if (s.t === 'link') {
              appendLink(parent, s.label || s.url, s.url);
              continue;
            }
            renderInlineMarkup(parent, s.v);
          }
        }
      }

      function renderInlineMarkup(parent, text) {
        const s = (text || '').toString();
        let i = 0;
        while (i < s.length) {
          // Inline code: `...`
          if (s.startsWith('`', i)) {
            const j = s.indexOf('`', i + 1);
            if (j > i + 1) {
              const code = s.slice(i + 1, j);
              const el = document.createElement('code');
              el.className = 'inlineCode';
              el.textContent = code;
              parent.appendChild(el);
              i = j + 1;
              continue;
            }
            // Unmatched marker: drop it.
            i += 1;
            continue;
          }

          // Bold: **...** or __...__
          if (s.startsWith('**', i)) {
            const j = s.indexOf('**', i + 2);
            if (j > i + 2) {
              const strong = document.createElement('strong');
              renderInlineMarkup(strong, s.slice(i + 2, j));
              parent.appendChild(strong);
              i = j + 2;
              continue;
            }
            // Unmatched marker: drop it.
            i += 2;
            continue;
          }
          if (s.startsWith('__', i)) {
            const j = s.indexOf('__', i + 2);
            if (j > i + 2) {
              const strong = document.createElement('strong');
              renderInlineMarkup(strong, s.slice(i + 2, j));
              parent.appendChild(strong);
              i = j + 2;
              continue;
            }
            // Unmatched marker: drop it.
            i += 2;
            continue;
          }

          // Plain text up to next marker.
          const next = (() => {
            const marks = [
              s.indexOf('`', i),
              s.indexOf('**', i),
              s.indexOf('__', i)
            ].filter(x => x >= 0);
            return marks.length ? Math.min.apply(null, marks) : -1;
          })();
          const end = next >= 0 ? next : s.length;
          if (end > i) appendTextWithBreaks(parent, s.slice(i, end));
          i = end;
        }
      }

      function renderMarkdownBlock(parent, text) {
        const s = (text || '').toString();
        const lines = s.split(/\r?\n/);
        for (const lineRaw of lines) {
          const line = (lineRaw || '').toString();
          if (!line.trim()) {
            const sp = document.createElement('div');
            sp.className = 'mdSpacer';
            parent.appendChild(sp);
            continue;
          }

          const h = /^(#{1,6})\s*(.+)$/.exec(line);
          if (h) {
            const lvl = h[1].length;
            const el = document.createElement('div');
            el.className = 'mdHeading ' + (lvl <= 1 ? 'mdH1' : (lvl === 2 ? 'mdH2' : 'mdH3'));
            renderInlineWithMd(el, h[2] || '');
            parent.appendChild(el);
            continue;
          }

          const b = /^\s*[-*]\s+(.*)$/.exec(line);
          if (b) {
            const el = document.createElement('div');
            el.className = 'mdBullet';
            appendTextWithBreaks(el, '• ');
            renderInlineWithMd(el, b[1] || '');
            parent.appendChild(el);
            continue;
          }

          const n = /^\s*(\d+)\.\s+(.*)$/.exec(line);
          if (n) {
            const el = document.createElement('div');
            el.className = 'mdBullet';
            appendTextWithBreaks(el, (n[1] || '1') + '. ');
            renderInlineWithMd(el, n[2] || '');
            parent.appendChild(el);
            continue;
          }

          const el = document.createElement('div');
          el.className = 'mdPara';
          renderInlineWithMd(el, line);
          parent.appendChild(el);
        }
      }

      function renderMessage(bubbleEl, text) {
        bubbleEl.textContent = '';

        const normalized = normalizeOpenFolderLinkFormatting(text);
        try {
          // Guard: huge outputs can freeze WebView2 if we build thousands of DOM nodes.
          if ((normalized || '').length > 20000) {
            bubbleEl.textContent = normalized;
            return;
          }
        } catch {}

        const blocks = splitCodeFences(normalized);
        for (const b of blocks) {
          if (b.t === 'code') {
            const pre = document.createElement('pre');
            pre.className = 'codeBlock';
            pre.textContent = (b.v || '').toString();
            bubbleEl.appendChild(pre);
            continue;
          }

          renderMarkdownBlock(bubbleEl, b.v);
        }
      }

      function splitAssistantControlText(text) {
        let remaining = (text || '').toString().trim();
        let plan = '';
        const planMatch = remaining.match(/^Plan:\s*([\s\S]*?)(?:\n\s*\n(?=Answer:)|$)/i);
        if (planMatch) {
          plan = (planMatch[1] || '').toString().trim();
          remaining = remaining.slice(planMatch[0].length).trim();
        }
        remaining = remaining.replace(/^Answer:\s*/i, '').trim();
        return { plan, text: remaining };
      }

      function displayTextForMessage(wrap, text) {
        const raw = (text || '').toString();
        if (!wrap || !wrap.classList || !wrap.classList.contains('assistant')) return raw;
        const parts = splitAssistantControlText(raw);
        return parts.text;
      }

      function setMessageText(wrap, text) {
        wrap._rawText = (text || '').toString();
        wrap._fullText = displayTextForMessage(wrap, wrap._rawText);
        wrap._finalized = true;
        wrap._plainTextNode = null;
        wrap.style.display = (wrap.classList.contains('assistant') && !wrap._fullText.trim()) ? 'none' : '';
        const bubble = wrap.querySelector('.bubble');
        renderMessage(bubble, wrap._fullText);
      }

      function ensurePlainTextNode(wrap) {
        const bubble = wrap.querySelector('.bubble');
        if (!bubble) return null;
        let n = wrap._plainTextNode;
        if (!n || n.nodeType !== 3 || n.parentNode !== bubble) {
          bubble.textContent = '';
          n = document.createTextNode('');
          bubble.appendChild(n);
          wrap._plainTextNode = n;
        }
        return n;
      }

      let pendingStreamByMessageId = new Map(); // messageId -> latest text
      let streamRaf = 0;

      function flushStreaming() {
        streamRaf = 0;
        try {
          for (const [mid, t] of pendingStreamByMessageId.entries()) {
            const wrap = msgById.get(mid);
            if (!wrap) continue;
            if (wrap._finalized) continue;
            wrap._fullText = (t || '').toString();
            wrap._finalized = false;
            const n = ensurePlainTextNode(wrap);
            if (n) n.data = wrap._fullText;
          }
        } catch {}
        pendingStreamByMessageId = new Map();
      }

      function setMessageTextStreaming(wrap, text) {
        wrap._rawText = (text || '').toString();
        wrap._fullText = displayTextForMessage(wrap, wrap._rawText);
        wrap._finalized = false;
        const mid = (wrap?.dataset?.messageId || '').toString();
        if (mid) pendingStreamByMessageId.set(mid, wrap._fullText);
        if (!streamRaf) streamRaf = requestAnimationFrame(flushStreaming);
      }

      function finalizeMessage(wrap) {
        try {
          if (!wrap || wrap._finalized) return;
          const mid = (wrap?.dataset?.messageId || '').toString();
          if (mid) pendingStreamByMessageId.delete(mid);
          if (!pendingStreamByMessageId.size && streamRaf) {
            try { cancelAnimationFrame(streamRaf); } catch {}
            streamRaf = 0;
          }
          wrap._finalized = true;
          wrap._plainTextNode = null;
          wrap._fullText = displayTextForMessage(wrap, wrap._rawText || wrap._fullText || '');
          wrap.style.display = (wrap.classList.contains('assistant') && !wrap._fullText.trim()) ? 'none' : '';
          const bubble = wrap.querySelector('.bubble');
          renderMessage(bubble, wrap._fullText || '');
          scrollMessagesToBottom(true);
        } catch {}
      }

      function scrollMessagesToBottom(afterLayout) {
        const apply = () => {
          try { scrollEl.scrollTop = scrollEl.scrollHeight; } catch {}
        };
        apply();
        if (!afterLayout) return;
        try {
          window.requestAnimationFrame(() => {
            apply();
            window.requestAnimationFrame(apply);
          });
        } catch {
          try { window.setTimeout(apply, 0); } catch {}
        }
      }

      function appendChat(role, text) {
        if ((role || '').toLowerCase() === 'system') {
          appendEvent(text);
          return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'msg';
        try { wrap.classList.add(((role || '').toString().trim().toLowerCase()) || 'assistant'); } catch {}
        const roleEl = document.createElement('div');
        roleEl.className = 'role';
        const roleText = document.createElement('div');
        roleText.className = 'roleText';
        roleText.textContent = displayRole(role);
        roleEl.appendChild(roleText);
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        wrap.appendChild(roleEl);
        wrap.appendChild(bubble);
        msgsEl.appendChild(wrap);
        setMessageText(wrap, text);
        scrollMessagesToBottom();
      }

      const msgById = new Map();
      const eventById = new Map();

      function appendEvent(text, messageId) {
        // Keep all activity visible in the Actions pane.
        if (!actionsEl) return;

        const mid = (messageId || '').toString();
        if (mid && eventById.has(mid)) {
          const el = eventById.get(mid);
          el.textContent = (text || '').toString();
          scrollActionsToBottom();
          return;
        }

        const el = document.createElement('div');
        el.className = 'event';
        el.textContent = (text || '').toString();
        if (mid) {
          el.dataset.messageId = mid;
          eventById.set(mid, el);
        }
        actionsEl.appendChild(el);
        scrollActionsToBottom();
      }

      function appendOrGetMessage(role, messageId) {
        if (messageId && msgById.has(messageId)) return msgById.get(messageId);

        const wrap = document.createElement('div');
        wrap.className = 'msg';
        try { wrap.classList.add(((role || '').toString().trim().toLowerCase()) || 'assistant'); } catch {}
        wrap._finalized = false;
        wrap._plainTextNode = null;
        wrap.dataset.messageId = messageId || '';
        const roleEl = document.createElement('div');
        roleEl.className = 'role';
        const roleText = document.createElement('div');
        roleText.className = 'roleText';
        roleText.textContent = displayRole(role);
        roleEl.appendChild(roleText);

        if ((role || '').toLowerCase() === 'assistant') {
          const btn = document.createElement('button');
          btn.className = 'speakBtn';
          btn.textContent = 'Speak';
          btn.disabled = true; // enabled on chat.done
          btn.style.display = 'none';
          btn.addEventListener('click', () => { speakMessage(wrap); });
          roleEl.appendChild(btn);
          wrap._speakBtn = btn;
        }
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        wrap.appendChild(roleEl);
        wrap.appendChild(bubble);
        msgsEl.appendChild(wrap);
        scrollMessagesToBottom();

        if (messageId) msgById.set(messageId, wrap);
        return wrap;
      }

      function deltaChat(role, messageId, textDelta) {
        if ((role || '').toLowerCase() === 'system') {
          const mid = (messageId || ('sys_' + Math.random().toString(16).slice(2))).toString();
          const prev = (mid && eventById.has(mid) ? (eventById.get(mid).textContent || '') : '');
          appendEvent(prev + (textDelta || ''), mid);
          return;
        }
        const wrap = appendOrGetMessage(role, messageId);
        const next = (wrap._rawText || wrap._fullText || '') + (textDelta || '');
        // If a late delta arrives after chat.done, keep markdown rendering intact.
        if (wrap._finalized) {
          setMessageText(wrap, next);
          scrollMessagesToBottom();
          return;
        }
        // Streaming can emit many tiny deltas; re-rendering markdown each time can freeze WebView2.
        // Render plain text during streaming and do the richer markdown render once on chat.done.
        setMessageTextStreaming(wrap, next);
        scrollMessagesToBottom();
      }

      let ttsAudio = null;
      let ttsActiveWrap = null;
      const ttsPendingByRequestId = new Map(); // requestId -> wrap

      function stopTts() {
        try {
          if (ttsAudio) {
            try { ttsAudio.pause(); } catch {}
            try { ttsAudio.currentTime = 0; } catch {}
          }
        } catch {}

        try {
          if (ttsActiveWrap && ttsActiveWrap._speakBtn) {
            ttsActiveWrap._speakBtn.textContent = 'Speak';
            ttsActiveWrap._speakBtn.disabled = false;
          }
        } catch {}

        ttsAudio = null;
        ttsActiveWrap = null;
      }

      function speakMessage(wrap) {
        try {
          const bubble = wrap.querySelector('.bubble');
          const text = (bubble?.textContent || '').trim();
          if (!text) return;

          // Toggle: if something is currently playing, stop.
          if (ttsAudio && !ttsAudio.paused) {
            stopTts();
            return;
          }

          const requestId = 'tts_' + Date.now() + '_' + Math.random().toString(16).slice(2);
          ttsPendingByRequestId.set(requestId, wrap);
          if (wrap._speakBtn) {
            wrap._speakBtn.textContent = 'Loading…';
            wrap._speakBtn.disabled = true;
          }

          // Ask the host to synthesize via the Operator backend (OpenAI TTS).
          post('voice.speak', { requestId, text, format: 'mp3' });
        } catch (e) {
          appendChat('system', 'Text-to-speech failed: ' + String(e));
        }
      }

      const fullJsonByKey = new Map(); // key = actionId + ':' + kind

      function toPrettyJson(obj) {
        try { return JSON.stringify(obj, null, 2); } catch { return '' + obj; }
      }

      function setPreTruncated(actionId, kind, pre, obj) {
        const s = toPrettyJson(obj);
        fullJsonByKey.set(actionId + ':' + kind, s);
        const maxChars = 6000;
        if (s.length <= maxChars) {
          pre.textContent = s;
        } else {
          pre.textContent = s.slice(0, maxChars) + '\\n…(truncated; use Copy to get full)';
        }
        pre.style.display = 'block';
      }

      function tryCopy(actionId, kind) {
        const s = fullJsonByKey.get(actionId + ':' + kind);
        if (!s) return;
        try {
          navigator.clipboard?.writeText(s);
        } catch {}
      }

      function computeConfirmPhrase(path, body) {
        try {
          const p = (path || '').toString();
          const b = body && typeof body === 'object' ? body : null;
          const isDry = b && (b.dryRun === true || b.apply === false);
          if (isDry) return null;

          const threshold = 25;
          if (p === '/revit/delete') {
            const ids = Array.isArray(b?.ids) ? b.ids : [];
            const count = ids.length;
            if (count > threshold) return 'DELETE ' + count + ' ELEMENTS';
          }
          if (p === '/revit/set-parameter') {
            const changes = Array.isArray(b?.changes) ? b.changes : [];
            const count = changes.length;
            if (count > threshold) return 'APPLY ' + count + ' CHANGES';
          }
        } catch {}
        return null;
      }

      function normalizeConfirm(s) {
        try {
          let t = (s || '').toString().trim();
          if (!t) return '';
          // Strip common copy-from-chat wrappers (markdown + quotes), iteratively.
          const pairs = [
            ['**', '**'],
            ['__', '__'],
            ['*', '*'],
            ['_', '_'],
            ['`', '`'],
            ['""', '""'],
            [""'"", ""'""]
          ];
          let changed = true;
          while (changed && t) {
            changed = false;
            for (const [pre, suf] of pairs) {
              if (t.startsWith(pre) && t.endsWith(suf) && t.length > pre.length + suf.length) {
                t = t.slice(pre.length, t.length - suf.length).trim();
                changed = true;
              }
            }
          }
          t = t.replace(/\s+/g, ' ').trim();
          return t;
        } catch { return (s || '').toString().trim(); }
      }

      function setApproveEnabled(el, enabled) {
        if (!el) return;
        try {
          const row = el.querySelector('.approveRow');
          const btns = row ? row.querySelectorAll('button') : [];
          for (const b of btns) b.disabled = !enabled;
        } catch {}
      }

      function postBodyUpdate(actionId, body) {
        try {
          post('action.body.update', { actionId, body });
        } catch {}
      }

      function setActionBody(actionId, body) {
        const el = ensureActionCard(actionId);
        const bodyDetails = el.querySelector('details.bodyDetails');
        const bodyPre = el.querySelector('pre.body');
        if (bodyDetails && bodyPre) {
          bodyDetails.style.display = (body !== undefined) ? 'block' : 'none';
          if (body !== undefined) setPreTruncated(actionId, 'body', bodyPre, body);
        }
        const st = actionState.get(actionId) || {};
        st.body = body;
        actionState.set(actionId, st);
        updateConfirmUi(actionId);
      }

      function updateConfirmUi(actionId) {
        const st = actionState.get(actionId);
        if (!st) return;
        const el = ensureActionCard(actionId);
        const expected = computeConfirmPhrase(st.path, st.body);
        const confirmRow = el.querySelector('.confirmRow');
        const confirmInput = el.querySelector('.confirmRow input');
        if (!confirmRow || !confirmInput) return;

        if (!expected) {
          confirmRow.style.display = 'none';
          setApproveEnabled(el, true);
          return;
        }

        confirmRow.style.display = 'flex';
        confirmInput.placeholder = expected;
        const existing = (st.body && typeof st.body === 'object' && typeof st.body.confirm === 'string') ? (st.body.confirm || '') : '';
        if (!confirmInput.value && existing) confirmInput.value = existing;

        const ok = normalizeConfirm(confirmInput.value || '') === expected;
        setApproveEnabled(el, ok);

        // If the user typed the correct phrase, persist it into the action body (host-side) so schema validation passes.
        if (ok) {
          try {
            if ((confirmInput.value || '').trim() !== expected) confirmInput.value = expected;
            const next = st.body && typeof st.body === 'object' ? { ...st.body, confirm: expected } : { confirm: expected };
            st.body = next;
            actionState.set(actionId, st);
            postBodyUpdate(actionId, next);
            const bodyPre = el.querySelector('pre.body');
            if (bodyPre) setPreTruncated(actionId, 'body', bodyPre, next);
          } catch {}
        }
      }

      function setPlan(actionId, planJson, error) {
        const el = ensureActionCard(actionId);
        const planDetails = el.querySelector('details.planDetails');
        if (!planDetails) return;

        const inner = planDetails.querySelector('.planInner');
        if (!inner) return;
        inner.innerHTML = '';

        if (error) {
          const pre = document.createElement('pre');
          pre.textContent = String(error);
          inner.appendChild(pre);
          planDetails.style.display = 'block';
          return;
        }

        if (!planJson || typeof planJson !== 'object') {
          planDetails.style.display = 'none';
          return;
        }

        // Special-case: set-parameter diff preview with exclusions.
        const st = actionState.get(actionId) || {};
        if (st.path === '/revit/set-parameter' && Array.isArray(planJson.diffs)) {
          const diffs = planJson.diffs;
          const sel = new Map();
          for (const d of diffs) {
            const key = (d && typeof d === 'object') ? ((d.elementId || '') + '|' + (d.parameterName || '')) : '';
            if (!key) continue;
            const checked = !!(d.ok && d.changed);
            sel.set(key, checked);
          }
          planSelectionByActionId.set(actionId, sel);

          const btnRow = document.createElement('div');
          btnRow.className = 'copyRow';
          const btnApply = document.createElement('button');
          btnApply.textContent = 'Apply selection';
          btnApply.title = 'Filter the request body to only the checked rows (before approving).';
          btnApply.addEventListener('click', () => {
            try {
              const baseJson = baseBodyJsonByActionId.get(actionId);
              if (!baseJson) return;
              const base = JSON.parse(baseJson);
              if (!base || typeof base !== 'object' || !Array.isArray(base.changes)) return;
              const keep = planSelectionByActionId.get(actionId) || new Map();
              base.changes = base.changes.filter(ch => {
                if (!ch || typeof ch !== 'object') return false;
                const k = String(ch.elementId || '') + '|' + String(ch.parameterName || '');
                return keep.get(k) === true;
              });
              delete base.confirm;
              setActionBody(actionId, base);
              postBodyUpdate(actionId, base);
            } catch {}
          });
          btnRow.appendChild(btnApply);
          inner.appendChild(btnRow);

          const table = document.createElement('table');
          const thead = document.createElement('thead');
          thead.innerHTML = '<tr><th></th><th>Element</th><th>Parameter</th><th>Before</th><th>After</th><th>Status</th></tr>';
          table.appendChild(thead);
          const tbody = document.createElement('tbody');

          const maxRows = Math.min(diffs.length, 200);
          for (let i = 0; i < maxRows; i++) {
            const d = diffs[i];
            if (!d || typeof d !== 'object') continue;
            const key = String(d.elementId || '') + '|' + String(d.parameterName || '');
            const tr = document.createElement('tr');

            const td0 = document.createElement('td');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = sel.get(key) === true;
            cb.addEventListener('change', () => {
              sel.set(key, cb.checked);
              planSelectionByActionId.set(actionId, sel);
            });
            td0.appendChild(cb);
            tr.appendChild(td0);

            const td1 = document.createElement('td');
            td1.className = 'mono';
            td1.textContent = String(d.elementId || '');
            tr.appendChild(td1);

            const td2 = document.createElement('td');
            td2.textContent = String(d.parameterName || '');
            tr.appendChild(td2);

            const td3 = document.createElement('td');
            td3.textContent = (d.before && typeof d.before === 'object' ? (d.before.valueString || '') : '') || '';
            tr.appendChild(td3);

            const td4 = document.createElement('td');
            td4.textContent = (d.after && typeof d.after === 'object' ? (d.after.valueString || '') : '') || '';
            tr.appendChild(td4);

            const td5 = document.createElement('td');
            td5.textContent = d.ok ? (d.changed ? 'changed' : 'no-op') : ('error: ' + String(d.error || ''));
            tr.appendChild(td5);

            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          inner.appendChild(table);

          if (diffs.length > maxRows) {
            const note = document.createElement('div');
            note.className = 'desc';
            note.textContent = `Showing first ${maxRows} of ${diffs.length} rows.`;
            inner.appendChild(note);
          }

          planDetails.style.display = 'block';
          return;
        }

        // Special-case: delete preview table (read-only).
        if (st.path === '/revit/delete' && Array.isArray(planJson.requestedDetails)) {
          const rows = planJson.requestedDetails;
          const sel = new Map();
          for (const r of rows) {
            const id = (r && typeof r === 'object') ? Number(r.elementId || 0) : 0;
            if (!id) continue;
            sel.set(String(id), r.exists !== false);
          }
          planSelectionByActionId.set(actionId, sel);

          const btnRow = document.createElement('div');
          btnRow.className = 'copyRow';
          const btnApply = document.createElement('button');
          btnApply.textContent = 'Apply selection';
          btnApply.title = 'Filter the request body to only the checked ids (before approving).';
          btnApply.addEventListener('click', () => {
            try {
              const baseJson = baseBodyJsonByActionId.get(actionId);
              if (!baseJson) return;
              const base = JSON.parse(baseJson);
              if (!base || typeof base !== 'object' || !Array.isArray(base.ids)) return;
              const keep = planSelectionByActionId.get(actionId) || new Map();
              base.ids = base.ids.filter(id => keep.get(String(id)) === true);
              delete base.confirm;
              setActionBody(actionId, base);
              postBodyUpdate(actionId, base);
            } catch {}
          });
          btnRow.appendChild(btnApply);
          inner.appendChild(btnRow);

          const hdr = document.createElement('div');
          hdr.className = 'desc';
          const req = Number(planJson.requestedCount || 0);
          const imp = Number(planJson.impactedCount || 0);
          hdr.textContent = `Requested: ${req}  Impacted: ${imp}`;
          inner.appendChild(hdr);

          const table = document.createElement('table');
          table.innerHTML = '<thead><tr><th></th><th>Element</th><th>Category</th><th>Name</th><th>UniqueId</th></tr></thead>';
          const tbody = document.createElement('tbody');
          const maxRows = Math.min(rows.length, 200);
          for (let i = 0; i < maxRows; i++) {
            const r = rows[i];
            if (!r || typeof r !== 'object') continue;
            const tr = document.createElement('tr');
            const id = String(r.elementId || '');

            const td0 = document.createElement('td');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = sel.get(id) === true;
            cb.addEventListener('change', () => {
              sel.set(id, cb.checked);
              planSelectionByActionId.set(actionId, sel);
            });
            td0.appendChild(cb);

            const td1 = document.createElement('td'); td1.className = 'mono'; td1.textContent = id;
            const td2 = document.createElement('td'); td2.textContent = String(r.category || '');
            const td3 = document.createElement('td'); td3.textContent = String(r.name || '');
            const td4 = document.createElement('td'); td4.className = 'mono'; td4.textContent = String(r.uniqueId || '');
            tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          inner.appendChild(table);
          planDetails.style.display = 'block';
          return;
        }

        // Fallback: show JSON.
        const pre = document.createElement('pre');
        setPreTruncated(actionId, 'plan', pre, planJson);
        inner.appendChild(pre);
        planDetails.style.display = 'block';
      }

      function ensureActionCard(actionId) {
        let el = actions.get(actionId);
        if (el) return el;

        el = document.createElement('div');
        el.className = 'action';
        el.dataset.actionId = actionId;

        const hdr = document.createElement('div');
        hdr.className = 'hdr';
        const title = document.createElement('div');
        title.className = 'title';
        const status = document.createElement('div');
        status.className = 'status statusPill tone-neutral';
        hdr.appendChild(title);
        hdr.appendChild(status);

        const path = document.createElement('div');
        path.className = 'path';

        const summary = document.createElement('div');
        summary.className = 'summary';

        const resultLinks = document.createElement('div');
        resultLinks.className = 'resultLinks';
        resultLinks.style.display = 'none';

        const approveRow = document.createElement('div');
        approveRow.className = 'approveRow';
        approveRow.style.display = 'none';

        const btnOnce = document.createElement('button');
        btnOnce.textContent = 'Approve once';
        btnOnce.addEventListener('click', () => post('action.approve', { actionId, grant: 'once' }));

        const btnSession = document.createElement('button');
        btnSession.textContent = 'Allow this session';
        btnSession.addEventListener('click', () => post('action.approve', { actionId, grant: 'session' }));

        const btnYolo = document.createElement('button');
        btnYolo.textContent = 'YOLO';
        btnYolo.addEventListener('click', () => post('action.approve', { actionId, grant: 'yolo' }));

        approveRow.appendChild(btnOnce);
        approveRow.appendChild(btnSession);
        approveRow.appendChild(btnYolo);

        const confirmRow = document.createElement('div');
        confirmRow.className = 'confirmRow';
        confirmRow.style.display = 'none';
        const confirmLbl = document.createElement('div');
        confirmLbl.className = 'lbl';
        confirmLbl.textContent = 'Type to confirm:';
        const confirmInput = document.createElement('input');
        confirmInput.type = 'text';
        confirmInput.addEventListener('input', () => updateConfirmUi(actionId));
        confirmRow.appendChild(confirmLbl);
        confirmRow.appendChild(confirmInput);

        const planDetails = document.createElement('details');
        planDetails.className = 'planDetails';
        const planSum = document.createElement('summary');
        planSum.textContent = 'Plan (dry run)';
        const planInner = document.createElement('div');
        planInner.className = 'planInner';
        planDetails.appendChild(planSum);
        planDetails.appendChild(planInner);
        planDetails.style.display = 'none';

        const bodyDetails = document.createElement('details');
        bodyDetails.className = 'bodyDetails';
        const bodySum = document.createElement('summary');
        bodySum.textContent = 'Request body';
        const bodyCopyRow = document.createElement('div');
        bodyCopyRow.className = 'copyRow';
        const bodyCopyBtn = document.createElement('button');
        bodyCopyBtn.textContent = 'Copy body';
        bodyCopyBtn.addEventListener('click', () => tryCopy(actionId, 'body'));
        bodyCopyRow.appendChild(bodyCopyBtn);
        const bodyPre = document.createElement('pre');
        bodyPre.className = 'body';
        bodyPre.style.display = 'none';
        bodyDetails.appendChild(bodySum);
        bodyDetails.appendChild(bodyCopyRow);
        bodyDetails.appendChild(bodyPre);
        bodyDetails.style.display = 'none';

        const resultDetails = document.createElement('details');
        resultDetails.className = 'resultDetails';
        const resultSum = document.createElement('summary');
        resultSum.textContent = 'Result';
        const resultCopyRow = document.createElement('div');
        resultCopyRow.className = 'copyRow';
        const resultCopyBtn = document.createElement('button');
        resultCopyBtn.textContent = 'Copy result';
        resultCopyBtn.addEventListener('click', () => tryCopy(actionId, 'result'));
        resultCopyRow.appendChild(resultCopyBtn);
        const resultPre = document.createElement('pre');
        resultPre.className = 'result';
        resultPre.style.display = 'none';
        resultDetails.appendChild(resultSum);
        resultDetails.appendChild(resultCopyRow);
        resultDetails.appendChild(resultPre);
        resultDetails.style.display = 'none';

        el.appendChild(hdr);
        el.appendChild(path);
        el.appendChild(summary);
        el.appendChild(resultLinks);
        el.appendChild(approveRow);
        el.appendChild(confirmRow);
        el.appendChild(planDetails);
        el.appendChild(bodyDetails);
        el.appendChild(resultDetails);
        actionsEl.appendChild(el);
        scrollActionsToBottom();
        actions.set(actionId, el);
        return el;
      }

      function setAction(actionId, title, path, body, approvalRequired) {
        const el = ensureActionCard(actionId);
        el.querySelector('.title').textContent = title || actionId;
        el.querySelector('.path').textContent = path;
        el.querySelector('.status').textContent = approvalRequired ? 'needs approval' : 'pending';
        el.querySelector('.summary').textContent = '';
        const approveRow = el.querySelector('.approveRow');
        approveRow.style.display = approvalRequired ? 'flex' : 'none';
        applyActionState(el, approvalRequired ? 'needs approval' : 'pending', null);

        // Persist state for confirm prompts and exclusion rebuild.
        actionState.set(actionId, { title: title || actionId, path: (path || '').toString(), approvalRequired: !!approvalRequired, body });
        if (!baseBodyJsonByActionId.has(actionId) && body !== undefined) {
          baseBodyJsonByActionId.set(actionId, toPrettyJson(body));
        }

        if (loopRunning && path) {
          runStatusActiveActions.add(actionId);
          runStatusActionHint = shortenRunHint(path);
          setRunStatusPhase('working');
          refreshRunStatus();
        }
        setActionBody(actionId, body);
      }

      function setStatus(actionId, status, error) {
        const el = ensureActionCard(actionId);
        const s = el.querySelector('.status');
        const label = (status || '').toString().replace(/_/g, ' ');
        s.textContent = label;
        if (error) s.textContent = label + ' - ' + error;
        const approveRow = el.querySelector('.approveRow');
        const needsApproval = (status === 'needs_approval') || ((status || '').toString().trim().toLowerCase() === 'needs approval');
        approveRow.style.display = needsApproval ? 'flex' : 'none';
        applyActionState(el, status, error);
        if (loopRunning) {
          const meta = actionState.get(actionId);
          const path = meta && meta.path ? meta.path : '';
          const normalized = (status || '').toString().trim().toLowerCase();
          if (needsApproval) {
            runStatusActiveActions.delete(actionId);
            runStatusActionHint = '';
            setRunStatusPhase('approval');
            refreshRunStatus();
          } else if (error) {
            runStatusActiveActions.delete(actionId);
            runStatusActionHint = '';
            setRunStatusPhase('retry');
            refreshRunStatus();
          } else if (normalized.includes('run') || normalized.includes('progress') || normalized.includes('pending')) {
            runStatusActiveActions.add(actionId);
            runStatusActionHint = shortenRunHint(path);
            setRunStatusPhase('working');
            refreshRunStatus();
          } else if (normalized.includes('done') || normalized.includes('success') || normalized.includes('applied')) {
            runStatusActiveActions.delete(actionId);
            runStatusActionHint = '';
            syncRunStatusPhaseFromActions();
            refreshRunStatus();
          } else if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel')) {
            runStatusActiveActions.delete(actionId);
            syncRunStatusPhaseFromActions();
            refreshRunStatus();
          } else {
            syncRunStatusPhaseFromActions();
            refreshRunStatus();
          }
        }
        scrollActionsToBottom();
      }

      function setResult(actionId, resultJson) {
        const el = ensureActionCard(actionId);
        const summary = el.querySelector('.summary');
        const links = el.querySelector('.resultLinks');
        try {
          if (resultJson && typeof resultJson === 'object') {
            if (resultJson.summary && typeof resultJson.summary === 'object' && typeof resultJson.summary.total === 'number') {
              summary.textContent = 'Summary: total=' + resultJson.summary.total;
            } else if (typeof resultJson.path === 'string') {
              summary.textContent = 'Summary: path=' + resultJson.path;
            } else if (Array.isArray(resultJson)) {
              summary.textContent = 'Summary: items=' + resultJson.length;
            } else {
              const keys = Object.keys(resultJson).slice(0, 8);
              summary.textContent = keys.length ? ('Summary: keys=' + keys.join(', ')) : '';
            }
          } else {
            summary.textContent = '';
          }
        } catch { summary.textContent = ''; }

        try {
          if (links) {
            links.innerHTML = '';
            links.style.display = 'none';
            const found = [];
            if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
              for (const [k, v] of Object.entries(resultJson)) {
                if (typeof v !== 'string') continue;
                const url = v.trim();
                const lower = url.toLowerCase();
                if (lower.startsWith('op://open-folder?path=') || lower.startsWith('revitoperator://open-folder?path=')) {
                  found.push({ key: k, url });
                }
              }
              if (typeof resultJson.path === 'string') {
                const p = (resultJson.path || '').toString().trim();
                if (p.toLowerCase().startsWith('artifacts/')) {
                  found.push({ key: 'path', url: 'op://open-folder?path=' + encodeOpPath(p) });
                }
              }
            }

            const max = Math.min(found.length, 4);
            for (let i = 0; i < max; i++) {
              const f = found[i];
              const btn = document.createElement('button');
              btn.textContent = 'Open ' + String(f.key || 'output').replace(/_url$/i, '').replace(/^open_/, '');
              btn.addEventListener('click', () => { handleLinkClick(f.url); });
              links.appendChild(btn);
            }
            if (max > 0) links.style.display = 'flex';
          }
        } catch {}

        const resultDetails = el.querySelector('details.resultDetails');
        const resultPre = el.querySelector('pre.result');
        if (resultDetails && resultPre) {
          resultDetails.style.display = 'block';
          setPreTruncated(actionId, 'result', resultPre, resultJson);
        }
        scrollActionsToBottom();
      }

      function onSend() {
        if (!authCanChat) {
          setAuthMessage(authBlockedReason || 'Sign-in required before sending chat.');
          return;
        }
        const text = (inputEl.value || '').trim();
        if (!text && (!Array.isArray(pendingAttachments) || pendingAttachments.length === 0)) return;
        inputEl.value = '';
        const messageId = (crypto?.randomUUID ? crypto.randomUUID() : (Date.now() + '' + Math.random()));
        lastRootMessageId = messageId;
        try { if (feedbackBarEl) feedbackBarEl.classList.remove('on'); } catch {}
        const policy = getAttachmentPolicy();
        const attachments = (policy.share_with_agent && Array.isArray(pendingAttachments)) ? pendingAttachments : [];
        const reasoningEffort = normalizeReasoningValue(reasoningSel ? reasoningSel.value : readStringPref('op.reasoningEffort', 'medium'));
        pendingAttachments = [];
        renderAttachStrip();
        post('chat.send', { messageId, text, attachments, attachment_policy: policy, reasoning_effort: reasoningEffort, speed_settings: getSpeedSettings(), brain_route: brainRouteSel && brainRouteSel.value === 'direct' ? 'direct' : 'auto' });
      }

      attachBtn.addEventListener('click', () => {
        post('file.pick', {});
      });

      screenBtn.addEventListener('click', () => {
        post('screen.capture', {});
      });

      async function blobToBase64NoPrefix(blob) {
        return await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => {
            const s = (fr.result || '').toString();
            const i = s.indexOf(',');
            resolve(i >= 0 ? s.slice(i + 1) : s);
          };
          fr.onerror = () => reject(new Error('Failed to read clipboard image.'));
          fr.readAsDataURL(blob);
        });
      }

      async function tryAttachImageFromPasteEvent(e) {
        try {
          const items = e?.clipboardData?.items;
          if (!items || !items.length) return false;
          for (const it of items) {
            if (!it) continue;
            const t = (it.type || '').toString().toLowerCase();
            if (!t.startsWith('image/')) continue;
            const blob = it.getAsFile ? it.getAsFile() : null;
            if (!blob) continue;
            const base64 = await blobToBase64NoPrefix(blob);
            if (!base64) continue;
            post('clipboard.image.attach', {
              data_base64: base64,
              mime: t || 'image/png'
            });
            return true;
          }
        } catch {}
        return false;
      }

      inputEl.addEventListener('paste', async (e) => {
        const attached = await tryAttachImageFromPasteEvent(e);
        if (attached) {
          e.preventDefault();
        }
      });

      // Load + persist attachment preferences.
      if (attShareEl) {
        try { attShareEl.checked = readBoolPref('op.attShare', true); } catch {}
        attShareEl.addEventListener('change', () => writeBoolPref('op.attShare', !!attShareEl.checked));
      }
      if (attAutoOpenEl) {
        try { attAutoOpenEl.checked = readBoolPref('op.attAutoOpenLatest', false); } catch {}
        attAutoOpenEl.addEventListener('change', () => writeBoolPref('op.attAutoOpenLatest', !!attAutoOpenEl.checked));
      }
      if (fbDevApplyEl) {
        try { fbDevApplyEl.checked = readBoolPref('op.fbDevApplyRepo', false); } catch {}
        fbDevApplyEl.addEventListener('change', () => writeBoolPref('op.fbDevApplyRepo', !!fbDevApplyEl.checked));
      }
      if (reasoningSel) {
        try { reasoningSel.value = normalizeReasoningValue(readStringPref('op.reasoningEffort', 'medium')); } catch {}
        reasoningSel.addEventListener('change', () => {
          const effort = normalizeReasoningValue(reasoningSel.value);
          reasoningSel.value = effort;
          writeStringPref('op.reasoningEffort', effort);
          post('reasoning.set', { effort });
        });
        post('reasoning.set', { effort: normalizeReasoningValue(reasoningSel.value) });
      }
      if (speedModeEl) {
        try {
          if (localStorage.getItem('op.speedDefaultsVersion') !== 'speed-on-56-sol-terra-medium-v2') {
            localStorage.setItem('op.speedMode', '1');
            localStorage.setItem('op.speedDiet', '1');
            localStorage.setItem('op.reasoningEffort', 'medium');
            localStorage.setItem('op.speedPlanner', 'gpt-5.6-sol');
            localStorage.setItem('op.speedExecutor', 'gpt-5.6-terra');
            localStorage.setItem('op.speedDefaultsVersion', 'speed-on-56-sol-terra-medium-v2');
            if (reasoningSel) {
              reasoningSel.value = 'medium';
              post('reasoning.set', { effort: 'medium' });
            }
          }
        } catch {}
        try { speedModeEl.checked = readBoolPref('op.speedMode', true); } catch {}
        speedModeEl.addEventListener('change', () => {
          writeBoolPref('op.speedMode', !!speedModeEl.checked);
          if (speedModeEl.checked && speedDietEl && !speedDietEl.checked) {
            speedDietEl.checked = true;
            writeBoolPref('op.speedDiet', true);
          }
        });
      }
      if (speedDietEl) {
        try { speedDietEl.checked = readBoolPref('op.speedDiet', true); } catch {}
        speedDietEl.addEventListener('change', () => writeBoolPref('op.speedDiet', !!speedDietEl.checked));
      }
      if (speedPlannerEl) {
        try { speedPlannerEl.value = normalizeSpeedModel(readStringPref('op.speedPlanner', 'gpt-5.6-sol'), 'gpt-5.6-sol'); } catch {}
        speedPlannerEl.addEventListener('change', () => {
          speedPlannerEl.value = normalizeSpeedModel(speedPlannerEl.value, 'gpt-5.6-sol');
          writeStringPref('op.speedPlanner', speedPlannerEl.value);
        });
      }
      if (speedExecutorEl) {
        try { speedExecutorEl.value = normalizeSpeedModel(readStringPref('op.speedExecutor', 'gpt-5.6-terra'), 'gpt-5.6-terra'); } catch {}
        speedExecutorEl.addEventListener('change', () => {
          speedExecutorEl.value = normalizeSpeedModel(speedExecutorEl.value, 'gpt-5.6-terra');
          writeStringPref('op.speedExecutor', speedExecutorEl.value);
        });
      }

      sendBtn.addEventListener('click', onSend);
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onSend();
        }
      });

      function setLoopUiState(running) {
        const was = loopRunning;
        loopRunning = !!running;
        if (loopRunning && !was) {
          runStatusStartedAt = Date.now();
          runStatusPhaseStartedAt = runStatusStartedAt;
          runStatusLastHeartbeatAt = 0;
          runStatusPhase = 'thinking';
          runStatusActionHint = '';
          runStatusActiveActions.clear();
          try { if (runStatusTimer) window.clearInterval(runStatusTimer); } catch {}
          runStatusTimer = window.setInterval(refreshRunStatus, 1000);
        } else if (!loopRunning && was) {
          try { if (runStatusTimer) window.clearInterval(runStatusTimer); } catch {}
          runStatusTimer = null;
          runStatusLastHeartbeatAt = 0;
          runStatusPhase = 'idle';
          runStatusPhaseStartedAt = 0;
          runStatusActionHint = '';
          runStatusActiveActions.clear();
        }
        cancelBtn.disabled = !loopRunning;
        cancelBtn.classList.toggle('micOn', loopRunning);
        try {
          if (feedbackBarEl) {
            if (was && !loopRunning) {
              feedbackBarEl.classList.add('on');
              scrollMessagesToBottom(true);
            }
            if (loopRunning) feedbackBarEl.classList.remove('on');
          }
        } catch {}
        refreshRunStatus();
      }
      cancelBtn.addEventListener('click', () => {
        if (cancelBtn.disabled) return;
        post('loop.cancel', {});
      });
      setLoopUiState(false);

      function submitFeedback(rating) {
        const r = (rating || '').toString().trim().toLowerCase();
        if (!r) return;
        const note = (fbNoteEl && fbNoteEl.value ? fbNoteEl.value : '').toString();
        const remember = !!(fbRememberEl && fbRememberEl.checked);
        const queue = !!(fbQueueEl && fbQueueEl.checked);
        const devApplyRepoChanges = !!(fbDevApplyEl && fbDevApplyEl.checked);
        post('feedback.submit', { chatId: lastRootMessageId, rating: r, note: note, rememberPreference: remember, queueUpload: queue, devApplyRepoChanges });
        try { if (feedbackBarEl) feedbackBarEl.classList.remove('on'); } catch {}
        try { if (fbNoteEl) fbNoteEl.value = ''; } catch {}
        try { if (fbRememberEl) fbRememberEl.checked = false; } catch {}
        try { if (fbQueueEl) fbQueueEl.checked = false; } catch {}
        try { if (fbDevApplyEl) fbDevApplyEl.checked = readBoolPref('op.fbDevApplyRepo', false); } catch {}
      }
      try {
        if (fbWorkedBtn) fbWorkedBtn.addEventListener('click', () => submitFeedback('worked'));
        if (fbPartialBtn) fbPartialBtn.addEventListener('click', () => submitFeedback('partial'));
        if (fbFailedBtn) fbFailedBtn.addEventListener('click', () => submitFeedback('failed'));
      } catch {}

      function base64FromUint8(u8) {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < u8.length; i += chunk) {
          binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
        }
        return btoa(binary);
      }

      function encodeWav16Mono(samplesF32, sampleRate) {
        const numSamples = samplesF32.length;
        const bytesPerSample = 2;
        const blockAlign = bytesPerSample * 1;
        const byteRate = sampleRate * blockAlign;
        const dataSize = numSamples * bytesPerSample;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const u8 = new Uint8Array(buffer);

        function writeAscii(offset, str) {
          for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        }

        writeAscii(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeAscii(8, 'WAVE');
        writeAscii(12, 'fmt ');
        view.setUint32(16, 16, true); // PCM header size
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true); // bits/sample
        writeAscii(36, 'data');
        view.setUint32(40, dataSize, true);

        let o = 44;
        for (let i = 0; i < numSamples; i++) {
          let s = Math.max(-1, Math.min(1, samplesF32[i]));
          s = s < 0 ? s * 0x8000 : s * 0x7fff;
          view.setInt16(o, s, true);
          o += 2;
        }

        return u8;
      }

      let recState = { recording: false, busy: false, session: null };

      function setRecUiState() {
        recStartBtn.disabled = recState.busy || recState.recording;
        recStopBtn.disabled = recState.busy || !recState.recording;
        recStartBtn.classList.toggle('micBusy', recState.busy);
        recStopBtn.classList.toggle('micBusy', recState.busy);
        recStopBtn.classList.toggle('micOn', recState.recording);
      }

      async function startWavRecordingFromStream(stream, options) {
        options = options || {};
        const stopTracksOnStop = options.stopTracksOnStop !== false;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioCtx({ sampleRate: 16000 });
        const sampleRate = audioCtx.sampleRate;

        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        const gain = audioCtx.createGain();
        gain.gain.value = 0;

        const chunks = [];
        let total = 0;
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          const copy = new Float32Array(input.length);
          copy.set(input);
          chunks.push(copy);
          total += copy.length;
        };

        source.connect(processor);
        processor.connect(gain);
        gain.connect(audioCtx.destination);
        try { await audioCtx.resume(); } catch {}

        let flushedSamples = 0;
        const exportPendingSamples = (force) => {
          const available = total - flushedSamples;
          if (available <= 0) return null;
          if (!force && available < sampleRate * 4) return null;
          const out = new Float32Array(available);
          let off = 0;
          let cursor = 0;
          for (const c of chunks) {
            const nextCursor = cursor + c.length;
            if (nextCursor <= flushedSamples) {
              cursor = nextCursor;
              continue;
            }
            const startIndex = Math.max(0, flushedSamples - cursor);
            const slice = c.subarray(startIndex);
            out.set(slice, off);
            off += slice.length;
            cursor = nextCursor;
          }
          flushedSamples = total;
          return { samples: out, sampleRate };
        };

        const stop = async () => {
          try { processor.disconnect(); } catch {}
          try { source.disconnect(); } catch {}
          try { gain.disconnect(); } catch {}
          if (stopTracksOnStop) {
            try { stream.getTracks().forEach(t => t.stop()); } catch {}
          }
          try { await audioCtx.close(); } catch {}
          return exportPendingSamples(true);
        };

        return { flushChunk: async (opts) => exportPendingSamples(!!(opts && opts.force)), stop };
      }

      function preferredCompressedAudioMimeType() {
        if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
        const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
        for (const candidate of candidates) {
          try {
            if (MediaRecorder.isTypeSupported(candidate)) return candidate;
          } catch {}
        }
        return '';
      }

      function formatFromMimeType(mimeType) {
        const lower = (mimeType || '').toString().trim().toLowerCase();
        if (lower.indexOf('webm') >= 0) return 'webm';
        if (lower.indexOf('ogg') >= 0) return 'ogg';
        if (lower.indexOf('mpeg') >= 0 || lower.indexOf('mp3') >= 0) return 'mp3';
        return 'wav';
      }

      function base64FromBlob(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = (reader.result || '').toString();
            const commaIndex = dataUrl.indexOf(',');
            if (commaIndex < 0) {
              reject(new Error('Failed to encode recorded audio.'));
              return;
            }
            resolve(dataUrl.slice(commaIndex + 1));
          };
          reader.onerror = () => reject(new Error('Failed to read recorded audio.'));
          reader.readAsDataURL(blob);
        });
      }

      function audioBufferToMonoSamples(audioBuffer) {
        const channels = Math.max(1, audioBuffer.numberOfChannels || 1);
        const length = audioBuffer.length || 0;
        const samples = new Float32Array(length);
        for (let channel = 0; channel < channels; channel++) {
          const data = audioBuffer.getChannelData(channel);
          for (let index = 0; index < length; index++) {
            samples[index] += data[index] / channels;
          }
        }
        return samples;
      }

      async function wavPayloadFromBlob(blob) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) throw new Error('Audio decoding is not available in this browser.');
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new AudioCtx();
        try {
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
          const wav = encodeWav16Mono(audioBufferToMonoSamples(audioBuffer), audioBuffer.sampleRate);
          return { audioBase64: base64FromUint8(wav), format: 'wav' };
        } finally {
          try { await audioCtx.close(); } catch {}
        }
      }

      async function startCompressedRecording(stream) {
        const mimeType = preferredCompressedAudioMimeType();
        if (!mimeType || typeof MediaRecorder === 'undefined') throw new Error('Compressed browser audio capture is not available.');
        const sampleFallback = await startWavRecordingFromStream(stream, { stopTracksOnStop: false });
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];
        const stopped = new Promise((resolve, reject) => {
          recorder.addEventListener('dataavailable', event => {
            if (event.data && event.data.size > 0) chunks.push(event.data);
          });
          recorder.addEventListener('stop', async () => {
            try {
              const blob = new Blob(chunks, { type: mimeType });
              if (blob.size <= 0) {
                resolve(null);
                return;
              }
              try {
                const decoded = await wavPayloadFromBlob(blob);
                await sampleFallback.flushChunk({ force: true });
                resolve(decoded);
              } catch {
                resolve(await sampleFallback.flushChunk({ force: true }));
              }
            } catch (err) {
              reject(err);
            }
          }, { once: true });
          recorder.addEventListener('error', event => reject((event && event.error) || new Error('Audio recording failed.')), { once: true });
        });
        recorder.start();
        return {
          stop: async () => {
            if (recorder.state !== 'inactive') recorder.stop();
            const audio = await stopped;
            try { await sampleFallback.stop(); } catch {}
            try { stream.getTracks().forEach(t => t.stop()); } catch {}
            return audio;
          }
        };
      }

      async function startWavRecording() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        try {
          return await startCompressedRecording(stream);
        } catch {
          return await startWavRecordingFromStream(stream);
        }
      }

      function setVoiceLive(text, on) {
        if (!voiceLiveEl) return;
        const t = (text || '').toString();
        voiceLiveEl.classList.toggle('on', !!on);
        voiceLiveEl.innerHTML = '';
        if (!on) return;
        if (t.trim()) {
          voiceLiveEl.textContent = t;
        } else {
          const span = document.createElement('span');
          span.className = 'muted';
          span.textContent = 'Listening...';
          voiceLiveEl.appendChild(span);
        }
      }

      function appendToComposer(text) {
        const t = (text || '').toString().replace(/\s+/g, ' ').trim();
        if (!t) return;
        inputEl.value = (inputEl.value || '').trim() ? ((inputEl.value || '').trim() + ' ' + t) : t;
        inputEl.focus();
      }

      async function onRecStart() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          appendChat('system', 'Voice dictation is not available (navigator.mediaDevices.getUserMedia missing).');
          return;
        }

        if (recState.busy || recState.recording) return;

        recState.busy = true;
        setRecUiState();
        try {
          recState.session = await startWavRecording();
          recState.recording = true;
          setVoiceLive('', true);
        } catch (err) {
          recState.session = null;
          appendChat('system', 'Microphone permission / init failed: ' + (err && err.message ? err.message : String(err)));
        } finally {
          recState.busy = false;
          setRecUiState();
        }
      }

      async function onRecStop() {
        if (recState.busy || !recState.recording || !recState.session) return;

        recState.busy = true;
        setRecUiState();

        const session = recState.session;
        recState.session = null;
        recState.recording = false;

        try {
          const result = await session.stop();
          let audioBase64 = '';
          let format = 'wav';
          if (result && result.audioBase64) {
            audioBase64 = (result.audioBase64 || '').toString().trim();
            format = (result.format || 'webm').toString().trim() || 'webm';
          } else if (result && result.samples && result.samples.length) {
            const wav = encodeWav16Mono(result.samples, result.sampleRate);
            audioBase64 = base64FromUint8(wav);
            format = 'wav';
          }
          if (!audioBase64) {
            appendChat('system', 'No microphone audio was captured.');
            return;
          }
          const requestId = (crypto?.randomUUID ? crypto.randomUUID() : (Date.now() + '' + Math.random()));
          post('voice.transcribe', { requestId, audioBase64, format });
        } catch (err) {
          appendChat('system', 'Voice recording failed: ' + (err && err.message ? err.message : String(err)));
        } finally {
          setVoiceLive('', false);
          recState.busy = false;
          setRecUiState();
        }
      }

      recStartBtn.addEventListener('click', () => { onRecStart(); });
      recStopBtn.addEventListener('click', () => { onRecStop(); });
      setRecUiState();

      newChatBtn.addEventListener('click', () => post('session.new', {}));

      policySel.addEventListener('change', () => {
        const mode = policySel.value;
        post('policy.set', { mode });
      });
      if (nativeApiPolicySel) {
        nativeApiPolicySel.addEventListener('change', () => {
          const profile = nativeApiPolicySel.value;
          post('native_api_policy.set', { profile });
        });
      }
      if (brainRouteSel) {
        try { brainRouteSel.value = readStringPref('op.brainRoute', 'auto') === 'direct' ? 'direct' : 'auto'; } catch {}
        brainRouteSel.addEventListener('change', () => {
          brainRouteSel.value = brainRouteSel.value === 'direct' ? 'direct' : 'auto';
          writeStringPref('op.brainRoute', brainRouteSel.value);
        });
      }

      if (authLoginBtn) {
        authLoginBtn.addEventListener('click', () => {
          const email = (authEmailEl?.value || '').toString().trim();
          const password = (authPasswordEl?.value || '').toString();
          if (!email || !password) {
            setAuthMessage('Email and password are required.');
            return;
          }
          setAuthMessage('Signing in...');
          post('auth.login', { email, password });
          try { if (authPasswordEl) authPasswordEl.value = ''; } catch {}
        });
      }

      if (authPasswordEl) {
        authPasswordEl.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          try { authLoginBtn?.click(); } catch {}
        });
      }

      if (authRefreshBtn) {
        authRefreshBtn.addEventListener('click', () => {
          setAuthMessage('Refreshing token...');
          post('auth.refresh', {});
        });
      }

      if (authSignOutBtn) {
        authSignOutBtn.addEventListener('click', () => {
          setAuthMessage('Signing out...');
          post('auth.signout', {});
        });
      }

      function setCloudStatus(text) {
        if (!cloudStatusEl) return;
        cloudStatusEl.textContent = (text || '').toString();
      }

      function fmtUtc(iso) {
        const s = (iso || '').toString().trim();
        if (!s) return '';
        try {
          const d = new Date(s);
          if (!Number.isFinite(d.getTime())) return s;
          return d.toLocaleString();
        } catch {
          return s;
        }
      }

      function setAuthMessage(text) {
        if (!authMessageEl) return;
        authMessageEl.textContent = (text || '').toString();
      }

      function applyAuthState(p) {
        const mode = (p.mode || 'none').toString();
        const enabled = !!p.auth_enabled;
        const configured = !!p.auth_configured;
        const signedIn = !!p.signed_in;
        const canChat = !!p.can_chat;
        const email = (p.email || '').toString();
        const userId = (p.user_id || '').toString();
        const exp = fmtUtc(p.token_expiry_utc);
        const refreshed = fmtUtc(p.last_refresh_utc);
        const message = (p.message || '').toString();
        const baseUrl = (p.auth_base_url || '').toString();

        authCanChat = canChat;
        authBlockedReason = canChat ? '' : (message || 'Sign-in required before sending chat.');

        if (authModeInfoEl) {
          const bits = [];
          bits.push('Mode: ' + mode);
          if (enabled) bits.push('Endpoint: ' + (baseUrl || '(missing auth_base_url)'));
          authModeInfoEl.textContent = bits.join('\\n');
        }

        if (authStateInfoEl) {
          const lines = [];
          if (!enabled) {
            lines.push('Shared token mode.');
          } else if (!configured) {
            lines.push('Auth endpoint not configured.');
          } else if (!signedIn) {
            lines.push('Not signed in.');
          } else {
            lines.push('Signed in as: ' + (email || userId || '(unknown user)'));
            if (exp) lines.push('Token expires: ' + exp);
            if (refreshed) lines.push('Last refresh: ' + refreshed);
          }
          if (message) lines.push(message);
          authStateInfoEl.textContent = lines.join('\\n');
        }

        if (authEmailEl) authEmailEl.disabled = !enabled || signedIn;
        if (authPasswordEl) authPasswordEl.disabled = !enabled || signedIn;
        if (authLoginBtn) authLoginBtn.disabled = !enabled || signedIn;
        if (authRefreshBtn) authRefreshBtn.disabled = !enabled || !signedIn;
        if (authSignOutBtn) authSignOutBtn.disabled = !enabled || !signedIn;

        if (authBadgeEl) {
          authBadgeEl.classList.remove('on');
          authBadgeEl.classList.remove('warn');
          if (!enabled) {
            setToneClass(authBadgeEl, 'neutral');
            authBadgeEl.textContent = 'Auth: local';
          } else if (canChat) {
            authBadgeEl.classList.add('on');
            setToneClass(authBadgeEl, 'positive');
            authBadgeEl.textContent = 'Auth: signed in';
          } else {
            authBadgeEl.classList.add('warn');
            setToneClass(authBadgeEl, 'warning');
            authBadgeEl.textContent = 'Auth: required';
          }
          authBadgeEl.title = message || 'Shared token mode';
        }

        if (sendBtn) sendBtn.disabled = !authCanChat;
        if (inputEl) {
          inputEl.disabled = !authCanChat;
          if (!authCanChat && authBlockedReason) inputEl.placeholder = authBlockedReason;
          else inputEl.placeholder = 'Type: ping, list views, capture view, print sheet A2.00… (Shift+Enter for newline)';
        }
      }

      function requestCloudSettings() {
        try { post('cloud_upload.load', {}); } catch {}
      }

      if (cloudSaveBtn) {
        cloudSaveBtn.addEventListener('click', () => {
          const url = (cloudUrlEl?.value || '').toString().trim();
          const mode = (cloudModeEl?.value || 'off').toString().trim();
          const tok = (cloudTokenEl?.value || '').toString().trim();
          const payload = { upload_url: url, mode };
          if (tok) payload.upload_token = tok;
          setCloudStatus('Saving…');
          post('cloud_upload.save', payload);
          try { if (cloudTokenEl) cloudTokenEl.value = ''; } catch {}
        });
      }

      if (cloudClearTokenBtn) {
        cloudClearTokenBtn.addEventListener('click', () => {
          const url = (cloudUrlEl?.value || '').toString().trim();
          const mode = (cloudModeEl?.value || 'off').toString().trim();
          setCloudStatus('Clearing token…');
          post('cloud_upload.save', { upload_url: url, mode, upload_token: null });
          try { if (cloudTokenEl) cloudTokenEl.value = ''; } catch {}
        });
      }

      if (cloudRefreshBtn) {
        cloudRefreshBtn.addEventListener('click', () => {
          setCloudStatus('Refreshing…');
          requestCloudSettings();
        });
      }

      for (const detailsEl of [authDetailsEl, cloudDetailsEl, attachDetailsEl, toolsDetailsEl]) {
        if (!detailsEl) continue;
        detailsEl.addEventListener('toggle', () => {
          try { window.requestAnimationFrame(syncRightRailLayout); } catch { syncRightRailLayout(); }
        });
      }

      window.addEventListener('resize', syncRightRailLayout);

      function resetUi() {
        msgsEl.innerHTML = '';
        if (eventsEl) eventsEl.innerHTML = '';
        actionsEl.innerHTML = '';
        actions.clear();
        msgById.clear();
        eventById.clear();
        fullJsonByKey.clear();
        inputEl.value = '';
        pendingAttachments = [];
        renderAttachStrip();
        inputEl.focus();
        setLoopUiState(false);
        try { window.requestAnimationFrame(syncRightRailLayout); } catch { syncRightRailLayout(); }

        // Friendly initial prompt.
        try { appendChat('assistant', 'How can I help?'); } catch {}
      }

      window.chrome?.webview?.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || msg.version !== PROTO || typeof msg.type !== 'string') return;
        const p = msg.payload || {};
        if (msg.type === 'chat.append') {
          const role = (p.role || 'system').toString();
          if (role.toLowerCase() === 'system') {
            appendEvent(p.text || '', p.messageId || '');
            return;
          }
          if (p.messageId) {
            const wrap = appendOrGetMessage(role, p.messageId);
            setMessageText(wrap, p.text || '');
            scrollMessagesToBottom();
          } else {
            appendChat(role, p.text || '');
          }
        }
        else if (msg.type === 'chat.reset') resetUi();
        else if (msg.type === 'chat.delta') {
          setRunStatusPhase('responding');
          runStatusActionHint = '';
          refreshRunStatus();
          deltaChat(p.role || 'assistant', p.messageId || '', p.textDelta || '');
        }
        else if (msg.type === 'action.add') setAction(p.actionId, p.title, p.path, p.body, !!p.approvalRequired);
        else if (msg.type === 'action.status') setStatus(p.actionId, p.status, p.error);
        else if (msg.type === 'action.plan') setPlan(p.actionId, p.planJson, p.error);
        else if (msg.type === 'action.result') setResult(p.actionId, p.resultJson);
        else if (msg.type === 'policy.current') {
          if (p.mode) policySel.value = p.mode;
        }
        else if (msg.type === 'reasoning.current') {
          const effort = normalizeReasoningValue(p.effort || (reasoningSel ? reasoningSel.value : 'medium'));
          if (reasoningSel) reasoningSel.value = effort;
          writeStringPref('op.reasoningEffort', effort);
        }
        else if (msg.type === 'native_api.policy.current') {
          const profile = (p.profile || '').toString();
          if (profile && nativeApiPolicySel) nativeApiPolicySel.value = profile;
          if (nativeApiPolicySel) {
            const locked = !!p.locked;
            nativeApiPolicySel.disabled = locked;
            const cap = [];
            cap.push('Native API profile: ' + (profile || (nativeApiPolicySel.value || 'broad')));
            if (p.max_risk) cap.push('maxRisk=' + p.max_risk);
            if (p.allow_mutating === false) cap.push('mutating=off');
            if (p.block_freeze_risk === true) cap.push('freezeRiskBlocked=on');
            if (locked) cap.push('locked');
            nativeApiPolicySel.title = cap.join(' | ');
          }
        }
        else if (msg.type === 'auth.state') {
          applyAuthState(p || {});
          setAuthMessage((p && p.message ? p.message : '').toString());
        }
        else if (msg.type === 'auth.error') {
          const err = (p.error || 'Authentication failed.').toString();
          setAuthMessage('Error: ' + err);
        }
        else if (msg.type === 'auth.required') {
          const reason = (p.message || 'Sign-in required before sending chat.').toString();
          setAuthMessage(reason);
        }
        else if (msg.type === 'write_grant.status') {
          const badge = document.getElementById('grantBadge');
          if (badge) {
            const active = !!p.active;
            const mode = (p.mode || '').toString() || 'none';
            const uses = (p.uses_remaining === 0 || p.uses_remaining) ? (' • ' + p.uses_remaining + 'x') : '';
            badge.classList.remove('on'); badge.classList.remove('warn');
            if (active) {
              badge.classList.add('on');
              setToneClass(badge, 'positive');
            } else if (p.error) {
              badge.classList.add('warn');
              setToneClass(badge, 'danger');
            } else {
              setToneClass(badge, 'neutral');
            }
            badge.textContent = active ? ('Grant: ' + mode + uses) : 'Grant: off';
            const exp = (p.expires_at_utc || '').toString();
            badge.title = active && exp ? ('Write grant active (' + mode + ') until ' + exp) : (p.error ? ('Write grant error: ' + p.error) : 'Bridge-layer write grant is off');
          }
        }
        else if (msg.type === 'loop.state') {
          setLoopUiState(!!p.running);
        }
        else if (msg.type === 'chat.start') {
          if (!loopRunning) setLoopUiState(true);
          syncRunStatusPhaseFromActions();
          refreshRunStatus();
        }
        else if (msg.type === 'heartbeat') {
          runStatusLastHeartbeatAt = Date.now();
          refreshRunStatus();
        }
        else if (msg.type === 'assistant.done') {
          syncRunStatusPhaseFromActions();
          runStatusActionHint = '';
          refreshRunStatus();
        }
        else if (msg.type === 'tools.list') {
          const list = p.tools || [];
          toolsEl.innerHTML = '';
          const groups = new Map();
          for (const t of list) {
            const g = (t.group || 'Other').toString();
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(t);
          }

          const groupNames = Array.from(groups.keys()).sort((a,b) => a.localeCompare(b));
          for (const g of groupNames) {
            const det = document.createElement('details');
            det.className = 'toolGroup';
            const sum = document.createElement('summary');
            sum.textContent = g;
            det.appendChild(sum);

            const inner = document.createElement('div');
            inner.className = 'tools';

            const items = groups.get(g);
            for (const t of items) {
              const el = document.createElement('div');
              el.className = 'tool';

              const hdr = document.createElement('div');
              hdr.className = 'hdr';
              const name = document.createElement('div');
              name.className = 'name';
              name.textContent = t.title || (t.method + ' ' + t.path);
              const risk = document.createElement('div');
              risk.className = 'risk';
              risk.textContent = (t.risk || '').toString().toLowerCase();
              hdr.appendChild(name);
              hdr.appendChild(risk);

              const path = document.createElement('div');
              path.className = 'path';
              path.textContent = (t.method || '') + ' ' + (t.path || '');

              const desc = document.createElement('div');
              desc.className = 'desc';
              desc.textContent = t.description || '';

              const row = document.createElement('div');
              row.className = 'row';
              const btn = document.createElement('button');
              btn.textContent = 'Insert';
              btn.addEventListener('click', () => {
                const ex = (t.example || '').toString().trim();
                inputEl.value = ex ? ex : (t.title || (t.method + ' ' + t.path)) + ' ';
                inputEl.focus();
              });
              row.appendChild(btn);

              el.appendChild(hdr);
              el.appendChild(path);
              el.appendChild(desc);
              el.appendChild(row);
              inner.appendChild(el);
            }

            det.appendChild(inner);
            toolsEl.appendChild(det);
          }
        }
        else if (msg.type === 'voice.result') {
          const text = (p.text || '').toString().trim();
          const err = (p.error || '').toString().trim();
          if (err) {
            appendChat('system', 'Voice transcription failed: ' + err);
          } else if (text) {
            appendToComposer(text);
          } else {
            appendChat('system', 'No speech was transcribed.');
          }
        }
        else if (msg.type === 'voice.speak.result') {
          const requestId = (p.requestId || '').toString();
          const err = (p.error || '').toString().trim();
          const audioBase64 = (p.audioBase64 || '').toString();
          const format = ((p.format || 'mp3').toString() || 'mp3').toLowerCase();

          const wrap = ttsPendingByRequestId.get(requestId);
          if (wrap) ttsPendingByRequestId.delete(requestId);

          if (!wrap) {
            if (err) appendChat('system', 'Text-to-speech failed: ' + err);
            return;
          }

          if (err) {
            try { if (wrap._speakBtn) { wrap._speakBtn.textContent = 'Speak'; wrap._speakBtn.disabled = false; } } catch {}
            appendChat('system', 'Text-to-speech failed: ' + err);
            return;
          }

          if (!audioBase64) {
            try { if (wrap._speakBtn) { wrap._speakBtn.textContent = 'Speak'; wrap._speakBtn.disabled = false; } } catch {}
            appendChat('system', 'Text-to-speech failed: empty audio payload.');
            return;
          }

          stopTts();

          const mime = format === 'wav' ? 'audio/wav' :
                       format === 'aac' ? 'audio/aac' :
                       format === 'flac' ? 'audio/flac' :
                       format === 'opus' ? 'audio/ogg' :
                       format === 'pcm' ? 'audio/wav' :
                       'audio/mpeg';

          const src = 'data:' + mime + ';base64,' + audioBase64;
          try {
            ttsAudio = new Audio(src);
          } catch (e) {
            try { if (wrap._speakBtn) { wrap._speakBtn.textContent = 'Speak'; wrap._speakBtn.disabled = false; } } catch {}
            appendChat('system', 'Text-to-speech playback failed: ' + String(e));
            return;
          }

          ttsActiveWrap = wrap;
          try { if (wrap._speakBtn) { wrap._speakBtn.textContent = 'Stop'; wrap._speakBtn.disabled = false; } } catch {}

          ttsAudio.onended = () => { stopTts(); };
          ttsAudio.onerror = () => { stopTts(); appendChat('system', 'Text-to-speech playback failed.'); };

          try {
            ttsAudio.play();
          } catch (e) {
            stopTts();
            appendChat('system', 'Text-to-speech playback failed: ' + String(e));
          }
        }
        else if (msg.type === 'chat.done') {
          const messageId = (p.messageId || '').toString();
          if (!messageId) return;
          const wrap = msgById.get(messageId);
          if (!wrap) return;
          try {
            const btn = wrap._speakBtn;
            if (btn) {
              btn.style.display = '';
              btn.disabled = false;
            }
          } catch {}
          finalizeMessage(wrap);
        }
        else if (msg.type === 'input.set') {
          const t = (p.text || '').toString();
          if (t) {
            inputEl.value = t;
            inputEl.focus();
          }
        }
        else if (msg.type === 'attachments.added') {
          const list = Array.isArray(p.attachments) ? p.attachments : [];
          for (const a of list) {
            if (!a || typeof a !== 'object') continue;
            const id = (a.id || '').toString();
            if (!id) continue;
            if (pendingAttachments.some(x => x && typeof x === 'object' && (x.id || '').toString() === id)) continue;
            pendingAttachments.push(a);
          }
          renderAttachStrip();
        }
        else if (msg.type === 'cloud_upload.current' || msg.type === 'cloud_upload.saved') {
          try {
            const url = (p.upload_url || '').toString();
            const mode = (p.mode || 'off').toString();
            const hasTok = !!p.has_token;
            if (cloudUrlEl && url) cloudUrlEl.value = url;
            if (cloudModeEl) cloudModeEl.value = mode;
            const bits = [];
            bits.push('Mode: ' + mode);
            bits.push(url ? ('URL: ' + url) : 'URL: (not set)');
            bits.push(hasTok ? 'Token: saved' : 'Token: (missing)');
            setCloudStatus(bits.join('\\n'));
          } catch {
            setCloudStatus('Cloud settings updated.');
          }
        }
        else if (msg.type === 'cloud_upload.error') {
          const err = (p.error || '').toString().trim();
          setCloudStatus(err ? ('Error: ' + err) : 'Cloud settings error.');
        }
      });

      // Load cloud upload settings once on startup.
      requestCloudSettings();
      try { post('auth.state.request', {}); } catch {}
      try { window.requestAnimationFrame(syncRightRailLayout); } catch { syncRightRailLayout(); }

      // Initial greeting (only if nothing has been rendered yet).
      try {
        if (msgsEl && msgsEl.children && msgsEl.children.length === 0) appendChat('assistant', 'How can I help?');
      } catch {}
    </script>
  </body>
</html>";
    }
}
