export class AssignmentKernelErrorV2 extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AssignmentKernelErrorV2";
  }
}

export function kernelAssertV2(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AssignmentKernelErrorV2(code, message);
}
