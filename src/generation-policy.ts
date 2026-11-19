/**
 * Per-student activity generation policy.
 *
 * "once_per_student": the first launch succeeds; later launches are refused.
 * "reuse_generation": every launch returns the same generation identifier.
 * "new_each_time": every launch creates a new generation identifier.
 *
 * A generation is distinct from a launch event: every successful Canvas
 * launch gets its own launch ID, even when reopening an existing generation.
 */
export const GENERATION_MODES = [
  'once_per_student',
  'reuse_generation',
  'new_each_time'
] as const;

export type GenerationMode = (typeof GENERATION_MODES)[number];

export function isGenerationMode(value: unknown): value is GenerationMode {
  return typeof value === 'string' && GENERATION_MODES.some(mode => mode === value);
}

export function generationModeLabel(mode: GenerationMode): string {
  switch (mode) {
    case 'once_per_student': return 'Once per student';
    case 'reuse_generation': return 'Reusable: reopen the same generation';
    case 'new_each_time': return 'Reusable: new generation on every launch';
  }
}
