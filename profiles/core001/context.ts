import type { ValidatorFinding } from '../../contract-builder/spec/lib/hook.js';
import type { ProjectModel } from '../../contract-builder/spec/lib/ir.js';
import type { AnalyzedSpec } from './view.js';

export interface CheckContext {
  model: ProjectModel;
  view: AnalyzedSpec;
  legacyText: string;
  legacyName: string;
}

export type Check = (ctx: CheckContext) => ValidatorFinding[] | Promise<ValidatorFinding[]>;
