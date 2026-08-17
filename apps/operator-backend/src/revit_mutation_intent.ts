const MUTATION_VERB_SOURCE = [
  "add", "adjust", "align", "annotate", "apply", "assign", "attach", "change", "clear", "configure", "connect", "convert", "copy", "create", "crop",
  "cut", "delete", "demolish", "detach", "dimension", "disable", "disconnect", "draft", "draw", "duplicate", "edit", "enable", "enter", "export", "extend", "fill", "filter", "fix",
  "group", "hide", "import", "increase", "insert", "isolate", "join", "link", "load", "lock", "make", "match", "mirror",
  "modify", "move", "offset", "pin", "place", "plot", "print", "purge", "reduce", "rehost", "reload", "remove", "rename", "replace", "reset", "restore", "revert",
  "resize", "rotate", "route", "run", "scale", "set", "sort", "split", "step", "swap", "sync", "tag", "trim", "unhide", "unload",
  "unlock", "unpin", "update", "write"
].join("|");

const MUTATION_VERB = new RegExp("\\b(?:" + MUTATION_VERB_SOURCE + ")\\b");

export function hasExplicitMutationVerb(userText: string | null | undefined): boolean {
  const text = `${userText || ""}`.toLowerCase();
  return MUTATION_VERB.test(text)
    || /\b(?:clean\s+up|correct|fill\s+(?:in|out)|mark|populate|put|relocate|renumber|reroute|rework|revise|turn\s+(?:off|on))\b/.test(text);
}
