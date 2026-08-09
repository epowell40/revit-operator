import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DYNAMIC_FILE_CAPABILITY_SCHEMA = "dynamic_file_capability/v1" as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const KINDS = new Set(["project_directory", "linked_document", "selected_input", "conversation_attachment", "company_library", "family_library", "task_scratch", "export_destination", "save_as_destination"]);
const ACCESS = new Set(["read", "write", "create"]);

export type DynamicFileCapabilityPublicV1 = {
  schema: typeof DYNAMIC_FILE_CAPABILITY_SCHEMA;
  capability_id: string;
  kind: string;
  access: ("read" | "write" | "create")[];
  scope: "file" | "directory";
  allowed_extensions: string[];
  maximum_output_count: number;
  maximum_output_bytes: number;
  task_id_hash: string;
  program_hash: string;
  document_fingerprint: string;
  principal_id_hash: string;
  expires_unix_seconds: number;
  maximum_use_count: number;
  raw_path_exposed: false;
};

export type DynamicFileCapabilityIssueRequest = Omit<DynamicFileCapabilityPublicV1, "schema" | "capability_id" | "raw_path_exposed"> & {
  absolute_path: string;
};

type Grant = { public: DynamicFileCapabilityPublicV1; canonicalRoot: string; uses: number; outputCount: number; outputBytes: number };

export class DynamicFileCapabilityAuthority {
  private readonly grants = new Map<string, Grant>();
  constructor(private readonly clock: () => number = () => Math.floor(Date.now() / 1000)) {}

  issue(request: DynamicFileCapabilityIssueRequest): DynamicFileCapabilityPublicV1 {
    validateIssue(request, this.clock());
    const canonicalRoot = canonicalizeCapabilityRoot(request.absolute_path, request.scope, request.access);
    const capabilityId = `filecap_${randomBytes(24).toString("base64url")}`;
    const publicCapability: DynamicFileCapabilityPublicV1 = {
      schema: DYNAMIC_FILE_CAPABILITY_SCHEMA, capability_id: capabilityId, kind: request.kind,
      access: [...request.access].sort(), scope: request.scope,
      allowed_extensions: request.allowed_extensions.map(value => value.toLowerCase()).sort(),
      maximum_output_count: request.maximum_output_count, maximum_output_bytes: request.maximum_output_bytes,
      task_id_hash: request.task_id_hash, program_hash: request.program_hash, document_fingerprint: request.document_fingerprint,
      principal_id_hash: request.principal_id_hash, expires_unix_seconds: request.expires_unix_seconds,
      maximum_use_count: request.maximum_use_count, raw_path_exposed: false
    };
    this.grants.set(capabilityId, { public: publicCapability, canonicalRoot, uses: 0, outputCount: 0, outputBytes: 0 });
    return Object.freeze({ ...publicCapability, access: [...publicCapability.access], allowed_extensions: [...publicCapability.allowed_extensions] });
  }

  resolve(args: {
    capability_id: string;
    operation: "read" | "write" | "create";
    relative_path?: string;
    expected_task_id_hash: string;
    expected_program_hash: string;
    expected_document_fingerprint: string;
    expected_principal_id_hash: string;
    reserve_output_bytes?: number;
  }): string {
    const grant = this.grants.get(args.capability_id);
    if (!grant || grant.public.expires_unix_seconds <= this.clock()) throw new Error("Dynamic file capability is unknown or expired.");
    if (!grant.public.access.includes(args.operation)) throw new Error("Dynamic file capability does not allow this access.");
    for (const [observed, expected, label] of [
      [grant.public.task_id_hash, args.expected_task_id_hash, "task"], [grant.public.program_hash, args.expected_program_hash, "program"],
      [grant.public.document_fingerprint, args.expected_document_fingerprint, "document"], [grant.public.principal_id_hash, args.expected_principal_id_hash, "principal"]
    ] as const) if (observed !== expected) throw new Error(`Dynamic file capability ${label} binding changed.`);
    if (grant.uses >= grant.public.maximum_use_count) throw new Error("Dynamic file capability use count is exhausted.");

    let resolved = grant.canonicalRoot;
    if (grant.public.scope === "directory") {
      const relative = args.relative_path;
      if (!relative || relative.length > 1024 || path.isAbsolute(relative) || relative.includes("\0")) throw new Error("Dynamic file capability relative path is invalid.");
      resolved = path.resolve(grant.canonicalRoot, relative);
      if (!isWithin(grant.canonicalRoot, resolved)) throw new Error("Dynamic file capability path escaped its directory scope.");
    } else if (args.relative_path !== undefined) throw new Error("File-scoped capability does not accept a relative path.");

    const extension = path.extname(resolved).toLowerCase();
    if (grant.public.allowed_extensions.length > 0 && !grant.public.allowed_extensions.includes(extension)) throw new Error("Dynamic file capability extension is not allowed.");
    if (args.operation === "read") {
      if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isDirectory()) throw new Error("Dynamic file capability input is unavailable.");
      requireNoReparse(resolved, true);
    } else {
      requireNoReparse(path.dirname(resolved), true);
      const reserve = args.reserve_output_bytes ?? 0;
      if (!Number.isSafeInteger(reserve) || reserve < 0 || grant.outputCount + 1 > grant.public.maximum_output_count || grant.outputBytes + reserve > grant.public.maximum_output_bytes) {
        throw new Error("Dynamic file capability output quota would be exceeded.");
      }
      grant.outputCount += 1; grant.outputBytes += reserve;
    }
    grant.uses += 1;
    return resolved;
  }
}

function validateIssue(request: DynamicFileCapabilityIssueRequest, now: number): void {
  if (!request || !KINDS.has(request.kind) || !path.isAbsolute(request.absolute_path) || !["file", "directory"].includes(request.scope)
    || !Array.isArray(request.access) || request.access.length < 1 || request.access.length > 3 || new Set(request.access).size !== request.access.length
    || request.access.some(value => !ACCESS.has(value)) || !Array.isArray(request.allowed_extensions) || request.allowed_extensions.length > 64
    || request.allowed_extensions.some(value => !/^\.[a-z0-9]{1,15}$/i.test(value))
    || !Number.isSafeInteger(request.maximum_output_count) || request.maximum_output_count < 0 || request.maximum_output_count > 10_000
    || !Number.isSafeInteger(request.maximum_output_bytes) || request.maximum_output_bytes < 0 || request.maximum_output_bytes > 20 * 1024 ** 3
    || !Number.isSafeInteger(request.expires_unix_seconds) || request.expires_unix_seconds <= now || request.expires_unix_seconds > now + 86_400
    || !Number.isSafeInteger(request.maximum_use_count) || request.maximum_use_count < 1 || request.maximum_use_count > 10_000) throw new Error("Dynamic file capability request is invalid.");
  for (const value of [request.task_id_hash, request.program_hash, request.document_fingerprint, request.principal_id_hash])
    if (!SHA256.test(value)) throw new Error("Dynamic file capability trusted binding is invalid.");
  if (request.access.every(value => value === "read") && (request.maximum_output_count !== 0 || request.maximum_output_bytes !== 0)) throw new Error("Read-only file capability cannot reserve output quota.");
}

function canonicalizeCapabilityRoot(input: string, scope: "file" | "directory", access: ("read" | "write" | "create")[]): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved)) {
    requireNoReparse(resolved, true);
    const stat = fs.statSync(resolved);
    if ((scope === "directory") !== stat.isDirectory()) throw new Error("Dynamic file capability scope does not match the selected path.");
    return fs.realpathSync.native(resolved);
  }
  if (scope !== "file" || !access.some(value => value === "write" || value === "create")) throw new Error("Dynamic file capability root does not exist.");
  const parent = path.dirname(resolved); requireNoReparse(parent, true);
  return path.join(fs.realpathSync.native(parent), path.basename(resolved));
}

function requireNoReparse(target: string, requireLeaf: boolean): void {
  const resolved = path.resolve(target); const parsed = path.parse(resolved); const relative = resolved.slice(parsed.root.length);
  let current = parsed.root;
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    if (!fs.existsSync(current)) {
      if (requireLeaf || index < parts.length - 1) throw new Error("Dynamic file capability path has a missing trusted ancestor.");
      return;
    }
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Dynamic file capability path crosses a reparse or symbolic link.");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export const DYNAMIC_EXTERNAL_EFFECT_SCHEMA = "dynamic_external_effect/v1" as const;
type EffectState = "planned" | "staged" | "inspected" | "authorized" | "published" | "verified" | "failed" | "outcome_uncertain";
type Effect = {
  schema: typeof DYNAMIC_EXTERNAL_EFFECT_SCHEMA; effect_id: string; effect_class: "export" | "save_as" | "print";
  state: EffectState; staging_directory: string; manifest_hash: string | null; authorization_hash: string | null; receipt_hash: string | null;
};

/** Trusted staging coordinator. Only export publication is implemented in v1; Save As and print remain separately gated. */
export class DynamicExternalEffectCoordinator {
  private readonly effects = new Map<string, Effect>();
  constructor(private readonly stagingRoot: string, private readonly files: DynamicFileCapabilityAuthority) {
    fs.mkdirSync(stagingRoot, { recursive: true }); requireNoReparse(stagingRoot, true);
  }

  plan(effectClass: "export" | "save_as" | "print"): Readonly<Effect> {
    const effectId = `effect_${randomUUID().replaceAll("-", "")}`; const directory = path.join(this.stagingRoot, effectId);
    const effect: Effect = { schema: DYNAMIC_EXTERNAL_EFFECT_SCHEMA, effect_id: effectId, effect_class: effectClass, state: "planned", staging_directory: directory, manifest_hash: null, authorization_hash: null, receipt_hash: null };
    this.effects.set(effectId, effect); return publicEffect(effect);
  }

  stage(effectId: string, outputs: { relative_path: string; bytes: Buffer }[]): Readonly<Effect> {
    const effect = this.require(effectId, "planned");
    if (effect.effect_class !== "export") throw new Error("Save As and print require dedicated trusted adapters and remain denied.");
    if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 10_000) throw new Error("External-effect stage manifest is invalid.");
    fs.mkdirSync(effect.staging_directory, { recursive: false });
    for (const output of outputs) {
      if (!output || !Buffer.isBuffer(output.bytes) || !output.relative_path || path.isAbsolute(output.relative_path)) throw new Error("External-effect staged output is invalid.");
      const target = path.resolve(effect.staging_directory, output.relative_path);
      if (!isWithin(effect.staging_directory, target)) throw new Error("External-effect staged output escaped staging.");
      fs.mkdirSync(path.dirname(target), { recursive: true }); requireNoReparse(path.dirname(target), true);
      fs.writeFileSync(target, output.bytes, { flag: "wx", mode: 0o600 });
    }
    effect.state = "staged"; return publicEffect(effect);
  }

  inspect(effectId: string): Readonly<Effect> {
    const effect = this.require(effectId, "staged"); const files = enumerateFiles(effect.staging_directory);
    effect.manifest_hash = sha256(files.map(file => `${file.relative}:${file.bytes}:${file.hash}`).join("\n"));
    effect.state = "inspected"; return publicEffect(effect);
  }

  authorize(effectId: string, expectedManifestHash: string, publicationAuthorizationHash: string): Readonly<Effect> {
    const effect = this.require(effectId, "inspected");
    if (effect.manifest_hash !== expectedManifestHash || !SHA256.test(publicationAuthorizationHash)) throw new Error("External-effect publication authorization is stale or invalid.");
    effect.authorization_hash = publicationAuthorizationHash; effect.state = "authorized"; return publicEffect(effect);
  }

  publish(effectId: string, destinationCapabilityId: string, bindings: { task: string; program: string; document: string; principal: string }): Readonly<Effect> {
    const effect = this.require(effectId, "authorized");
    if (effect.effect_class !== "export") throw new Error("Only staged export publication is implemented.");
    const staged = enumerateFiles(effect.staging_directory);
    try {
      for (const file of staged) {
        const destination = this.files.resolve({ capability_id: destinationCapabilityId, operation: "create", relative_path: file.relative,
          expected_task_id_hash: bindings.task, expected_program_hash: bindings.program, expected_document_fingerprint: bindings.document,
          expected_principal_id_hash: bindings.principal, reserve_output_bytes: file.bytes });
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.stage-${randomUUID().replaceAll("-", "")}`;
        fs.copyFileSync(file.absolute, temporary, fs.constants.COPYFILE_EXCL); fs.renameSync(temporary, destination);
      }
      effect.receipt_hash = sha256(`${effect.effect_id}\n${effect.manifest_hash}\n${effect.authorization_hash}\n${staged.length}`);
      effect.state = "published"; return publicEffect(effect);
    } catch (error) {
      effect.state = "outcome_uncertain";
      throw error;
    }
  }

  verify(effectId: string, expectedReceiptHash: string): Readonly<Effect> {
    const effect = this.require(effectId, "published");
    if (effect.receipt_hash !== expectedReceiptHash) throw new Error("External-effect publication receipt did not verify.");
    effect.state = "verified"; return publicEffect(effect);
  }

  private require(effectId: string, state: EffectState): Effect {
    const effect = this.effects.get(effectId); if (!effect || effect.state !== state) throw new Error("External-effect state transition is invalid."); return effect;
  }
}

function enumerateFiles(root: string): { absolute: string; relative: string; bytes: number; hash: string }[] {
  requireNoReparse(root, true); const result: { absolute: string; relative: string; bytes: number; hash: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name); if (entry.isSymbolicLink()) throw new Error("Staging contains a reparse or symbolic link.");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) { const bytes = fs.statSync(absolute).size; result.push({ absolute, relative: path.relative(root, absolute), bytes, hash: sha256(fs.readFileSync(absolute)) }); }
      else throw new Error("Staging contains an unsupported filesystem object.");
    }
  };
  visit(root); return result.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
}

function sha256(value: string | Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function publicEffect(effect: Effect): Readonly<Effect> { return Object.freeze({ ...effect, staging_directory: "opaque:trusted-staging" }); }
