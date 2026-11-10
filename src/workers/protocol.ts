// Message types for the workers (the shapes now live in shared/results.ts; this file goes away with the workers).
import type { BootstrapResult, GuideMethod, MsaResult } from '../shared/results';
import type { DistanceMatrix } from '../shared/types';

export type { BootstrapRequest, DistancesRequest, MsaRequest } from '../shared/results';
export type DistancesResult = DistanceMatrix;
export type { BootstrapResult };
export type MsaWorkerResult = MsaResult;
export type { GuideMethod };
