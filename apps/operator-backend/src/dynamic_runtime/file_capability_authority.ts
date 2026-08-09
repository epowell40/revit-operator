import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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

type CapabilityUse = {
  capability_id: string;
  operation: "read" | "write" | "create";
  relative_path?: string;
  expected_task_id_hash: string;
  expected_program_hash: string;
  expected_document_fingerprint: string;
  expected_principal_id_hash: string;
};

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

  /** Read-only resolution. Mutating callers must use an operation-specific API that never exposes a naked path. */
  resolve(args: CapabilityUse): string {
    if (args.operation !== "read") throw new Error("Mutating dynamic file capabilities require the atomic create API.");
    const { grant, resolved } = this.validateUse(args);
    if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isDirectory()) throw new Error("Dynamic file capability input is unavailable.");
    requireNoReparse(resolved, true);
    grant.uses += 1;
    return resolved;
  }

  /** Atomically creates a new output and writes through a held descriptor. Existing or reparse leaves are never followed or replaced. */
  createFile(args: Omit<CapabilityUse, "operation"> & { bytes: Buffer }): { relative_path: string; bytes: number; hash: string } {
    if (!Buffer.isBuffer(args.bytes)) throw new Error("Dynamic file capability output must be bytes.");
    const use: CapabilityUse = { ...args, operation: "create" };
    const { grant, resolved, relative } = this.validateUse(use);
    if (grant.outputCount + 1 > grant.public.maximum_output_count || grant.outputBytes + args.bytes.length > grant.public.maximum_output_bytes) {
      throw new Error("Dynamic file capability output quota would be exceeded.");
    }

    const parent = path.dirname(resolved);
    requireNoReparse(grant.canonicalRoot, true);
    requireNoReparse(parent, true);
    if (!isWithin(grant.canonicalRoot, parent) && parent !== grant.canonicalRoot) throw new Error("Dynamic file capability output parent escaped its directory scope.");
    if (fs.existsSync(resolved)) throw new Error("Dynamic file capability create target already exists.");

    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(resolved, "wx", 0o600);
      assertHeldOutputIsAnchored(descriptor, resolved, grant.canonicalRoot);
      fs.writeFileSync(descriptor, args.bytes);
      fs.fsyncSync(descriptor);
      assertHeldOutputIsAnchored(descriptor, resolved, grant.canonicalRoot);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* best effort */ }
        descriptor = undefined;
        try { if (fs.existsSync(resolved) && !fs.lstatSync(resolved).isSymbolicLink()) fs.unlinkSync(resolved); } catch { /* preserve original failure */ }
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }

    grant.uses += 1;
    grant.outputCount += 1;
    grant.outputBytes += args.bytes.length;
    return { relative_path: relative, bytes: args.bytes.length, hash: sha256(args.bytes) };
  }

  private validateUse(args: CapabilityUse): { grant: Grant; resolved: string; relative: string } {
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
    return { grant, resolved, relative: grant.public.scope === "directory" ? path.relative(grant.canonicalRoot, resolved) : path.basename(resolved) };
  }
}

function assertHeldOutputIsAnchored(descriptor: number, target: string, root: string): void {
  requireNoReparse(root, true); requireNoReparse(path.dirname(target), true); requireNoReparse(target, true);
  const held = fs.fstatSync(descriptor); const leaf = fs.statSync(target);
  if (!held.isFile() || !leaf.isFile() || held.dev !== leaf.dev || held.ino !== leaf.ino) throw new Error("Dynamic file capability output changed during secure creation.");
  const actualParent = fs.realpathSync.native(path.dirname(target));
  if (actualParent !== root && !isWithin(root, actualParent)) throw new Error("Dynamic file capability output parent escaped its directory scope.");
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
  inspected_files: FileIdentity[] | null; authorized_destination_hash: string | null; authorized_bindings_hash: string | null;
  publication_authorization: DynamicPublicationAuthorizationV1 | null;
};

type FileIdentity = { relative: string; bytes: number; hash: string };
export const DYNAMIC_PUBLICATION_AUTHORIZATION_SCHEMA = "dynamic_external_effect_publication_authorization/v1" as const;
export type DynamicPublicationAuthorizationV1 = {
  schema: typeof DYNAMIC_PUBLICATION_AUTHORIZATION_SCHEMA;
  effect_id: string; effect_class: "export" | "save_as" | "print"; manifest_hash: string;
  destination_capability_id_hash: string; bindings_hash: string; expires_unix_seconds: number; nonce: string; signature: string;
};

/** Trusted authorization signer. The secret remains outside model/runtime-visible contracts. */
export class DynamicPublicationAuthorizationAuthority {
  constructor(private readonly key: Buffer, private readonly clock: () => number = () => Math.floor(Date.now() / 1000)) {
    if (!Buffer.isBuffer(key) || key.length < 32) throw new Error("Publication authorization key must contain at least 256 bits.");
  }
  issue(args: Omit<DynamicPublicationAuthorizationV1, "schema" | "nonce" | "signature">): Readonly<DynamicPublicationAuthorizationV1> {
    if (args.expires_unix_seconds <= this.clock() || args.expires_unix_seconds > this.clock() + 900 || !SHA256.test(args.manifest_hash)
      || !SHA256.test(args.destination_capability_id_hash) || !SHA256.test(args.bindings_hash)) throw new Error("Publication authorization request is invalid.");
    const unsigned = { schema: DYNAMIC_PUBLICATION_AUTHORIZATION_SCHEMA, ...args, nonce: randomBytes(24).toString("base64url") };
    return Object.freeze({ ...unsigned, signature: signAuthorization(this.key, unsigned) });
  }
  verify(receipt: DynamicPublicationAuthorizationV1): void {
    if (!receipt || receipt.schema !== DYNAMIC_PUBLICATION_AUTHORIZATION_SCHEMA || receipt.expires_unix_seconds <= this.clock()) throw new Error("Publication authorization is invalid or expired.");
    const { signature, ...unsigned } = receipt; const expected = signAuthorization(this.key, unsigned);
    const left = Buffer.from(signature, "utf8"); const right = Buffer.from(expected, "utf8");
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Publication authorization signature is invalid.");
  }
}

/** Trusted staging coordinator. Only export publication is implemented in v1; Save As and print remain separately gated. */
export class DynamicExternalEffectCoordinator {
  private readonly effects = new Map<string, Effect>();
  constructor(private readonly stagingRoot: string, private readonly files: DynamicFileCapabilityAuthority, private readonly authorizations: DynamicPublicationAuthorizationAuthority) {
    fs.mkdirSync(stagingRoot, { recursive: true }); requireNoReparse(stagingRoot, true);
  }

  plan(effectClass: "export" | "save_as" | "print"): Readonly<Effect> {
    const effectId = `effect_${randomUUID().replaceAll("-", "")}`; const directory = path.join(this.stagingRoot, effectId);
    const effect: Effect = { schema: DYNAMIC_EXTERNAL_EFFECT_SCHEMA, effect_id: effectId, effect_class: effectClass, state: "planned", staging_directory: directory, manifest_hash: null, authorization_hash: null, receipt_hash: null, inspected_files: null, authorized_destination_hash: null, authorized_bindings_hash: null, publication_authorization: null };
    this.effects.set(effectId, effect); return publicEffect(effect);
  }

  stage(effectId: string, outputs: { relative_path: string; bytes: Buffer }[]): Readonly<Effect> {
    const effect = this.require(effectId, "planned");
    if (effect.effect_class !== "export") throw new Error("Save As and print require dedicated trusted adapters and remain denied.");
    // v1 publishes one exact leaf atomically. Multi-file/nested publication needs a dedicated
    // directory transaction and remains fail-closed instead of risking a partial destination.
    if (!Array.isArray(outputs) || outputs.length !== 1) throw new Error("External-effect v1 requires exactly one staged output.");
    fs.mkdirSync(effect.staging_directory, { recursive: false });
    for (const output of outputs) {
      if (!output || !Buffer.isBuffer(output.bytes) || !output.relative_path || path.isAbsolute(output.relative_path)
        || path.dirname(output.relative_path) !== "." || output.relative_path.includes("/") || output.relative_path.includes("\\")) throw new Error("External-effect staged output must be one direct leaf file.");
      const target = path.resolve(effect.staging_directory, output.relative_path);
      if (!isWithin(effect.staging_directory, target)) throw new Error("External-effect staged output escaped staging.");
      fs.mkdirSync(path.dirname(target), { recursive: true }); requireNoReparse(path.dirname(target), true);
      fs.writeFileSync(target, output.bytes, { flag: "wx", mode: 0o600 });
    }
    effect.state = "staged"; return publicEffect(effect);
  }

  inspect(effectId: string): Readonly<Effect> {
    const effect = this.require(effectId, "staged"); const files = enumerateFiles(effect.staging_directory);
    effect.inspected_files = files.map(({ relative, bytes, hash }) => ({ relative, bytes, hash }));
    effect.manifest_hash = manifestHash(effect.inspected_files);
    effect.state = "inspected"; return publicEffect(effect);
  }

  authorize(effectId: string, authorization: DynamicPublicationAuthorizationV1, destinationCapabilityId: string, bindings: { task: string; program: string; document: string; principal: string }): Readonly<Effect> {
    const effect = this.require(effectId, "inspected");
    this.authorizations.verify(authorization);
    const destinationHash = sha256(destinationCapabilityId); const expectedBindingsHash = bindingsHash(bindings);
    if (authorization.effect_id !== effect.effect_id || authorization.effect_class !== effect.effect_class || authorization.manifest_hash !== effect.manifest_hash
      || authorization.destination_capability_id_hash !== destinationHash || authorization.bindings_hash !== expectedBindingsHash) {
      throw new Error("External-effect publication authorization is stale or bound to another effect.");
    }
    effect.authorization_hash = sha256(canonicalAuthorization(authorization)); effect.authorized_destination_hash = destinationHash;
    effect.authorized_bindings_hash = expectedBindingsHash;
    effect.publication_authorization = Object.freeze({ ...authorization }); effect.state = "authorized"; return publicEffect(effect);
  }

  publish(effectId: string, destinationCapabilityId: string, bindings: { task: string; program: string; document: string; principal: string }): Readonly<Effect> {
    const effect = this.require(effectId, "authorized");
    if (effect.effect_class !== "export") throw new Error("Only staged export publication is implemented.");
    if (!effect.publication_authorization) throw new Error("External-effect publication authorization is missing.");
    this.authorizations.verify(effect.publication_authorization);
    if (effect.authorization_hash !== sha256(canonicalAuthorization(effect.publication_authorization))) {
      throw new Error("External-effect publication authorization changed after approval.");
    }
    if (effect.authorized_destination_hash !== sha256(destinationCapabilityId) || effect.authorized_bindings_hash !== bindingsHash(bindings)) {
      throw new Error("External-effect publication destination or identity binding changed.");
    }
    const staged = snapshotFiles(effect.staging_directory);
    const actualIdentities = staged.map(({ relative, bytes, hash }) => ({ relative, bytes, hash }));
    if (manifestHash(actualIdentities) !== effect.manifest_hash || JSON.stringify(actualIdentities) !== JSON.stringify(effect.inspected_files)) {
      effect.state = "failed"; throw new Error("External-effect staged content changed after inspection.");
    }
    try {
      for (const file of staged) {
        this.files.createFile({ capability_id: destinationCapabilityId, relative_path: file.relative,
          expected_task_id_hash: bindings.task, expected_program_hash: bindings.program, expected_document_fingerprint: bindings.document,
          expected_principal_id_hash: bindings.principal, bytes: file.buffer });
      }
      const destinations = actualIdentities.map(file => ({ ...file, destination_path_hash: sha256(`${destinationCapabilityId}\n${file.relative}`) }));
      effect.receipt_hash = sha256(JSON.stringify({ effect_id: effect.effect_id, manifest_hash: effect.manifest_hash, authorization_hash: effect.authorization_hash, files: destinations }));
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

function snapshotFiles(root: string): { relative: string; bytes: number; hash: string; buffer: Buffer }[] {
  const files = enumerateFiles(root); let total = 0;
  return files.map(file => {
    const buffer = fs.readFileSync(file.absolute); total += buffer.length;
    if (total > 512 * 1024 * 1024) throw new Error("External-effect staged snapshot exceeds its trusted publication bound.");
    const identity = { relative: file.relative, bytes: buffer.length, hash: sha256(buffer), buffer };
    if (identity.bytes !== file.bytes || identity.hash !== file.hash) throw new Error("External-effect staged content changed while being snapshotted.");
    return identity;
  });
}

function manifestHash(files: FileIdentity[]): string { return sha256(files.map(file => `${file.relative}:${file.bytes}:${file.hash}`).join("\n")); }
function bindingsHash(bindings: { task: string; program: string; document: string; principal: string }): string {
  for (const value of [bindings.task, bindings.program, bindings.document, bindings.principal]) if (!SHA256.test(value)) throw new Error("External-effect identity binding is invalid.");
  return sha256(`${bindings.task}\n${bindings.program}\n${bindings.document}\n${bindings.principal}`);
}
function canonicalAuthorization(value: Omit<DynamicPublicationAuthorizationV1, "signature">): string {
  return [value.schema, value.effect_id, value.effect_class, value.manifest_hash, value.destination_capability_id_hash, value.bindings_hash, value.expires_unix_seconds, value.nonce].join("\n");
}
function signAuthorization(key: Buffer, value: Omit<DynamicPublicationAuthorizationV1, "signature">): string {
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalAuthorization(value)).digest("hex")}`;
}

function sha256(value: string | Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function publicEffect(effect: Effect): Readonly<Effect> {
  const { inspected_files: _inspected, authorized_destination_hash: _destination, authorized_bindings_hash: _bindings, publication_authorization: _authorization, ...visible } = effect;
  return Object.freeze({ ...visible, staging_directory: "opaque:trusted-staging" }) as Readonly<Effect>;
}
