export type ModuleId = "csa" | "msci" | "mainland" | "hkex" | "benchmark";
export interface DocumentRef {
  id: string;
  company?: string;
  period?: string;
  isOwn?: boolean;
  meta?: Record<string, any>;
  sha256?: string;
}
export interface DocumentInfo {
  id: string;
  name: string;
  pageCount: number;
  bytes: number;
  sha256: string;
  meta: Record<string, any>;
}
export interface Project {
  id: string;
  name: string;
  company: string;
  module: ModuleId;
  reportPeriod: string;
  targetPeriod: string;
  options: Record<string, any>;
  documents: DocumentRef[];
  selected: string[];
  methodId?: string;
  comments: Record<string, string>;
  revision?: number;
  updatedAt?: number;
  runIds?: string[];
  lastRunId?: string;
  stale?: boolean;
  mappingOverrides?: Record<string, any[]>;
  importWarnings?: string[];
  legacySnapshot?: Record<string, any>;
  deletedAt?: number;
  hasNativeDraft?: boolean;
  lastSavedAt?: number;
  createdAt?: number;
}
export interface Criterion {
  id: string;
  title: string;
  group: string;
  requirement: string;
  detail: string;
  source: string;
  page?: number;
  default?: boolean;
}
export interface Method {
  id: string;
  module: ModuleId;
  label: string;
  version: string;
  status: "draft" | "published";
  hash: string;
  catalogKey: string;
  options: Record<string, any>;
  payload: Record<string, any>;
  sourceNote: string;
  parentId?: string;
  isDefault?: boolean;
}
export interface Result {
  id: string;
  title: string;
  status: string;
  disclosure: string;
  gap: string;
  suggestion: string;
  evidence: {
    documentId: string;
    page: number;
    quote: string;
    name?: string;
  }[];
  company?: string;
  companyDocumentId?: string;
  raw: Record<string, any>;
}
export interface Run {
  id: string;
  module: ModuleId;
  projectId: string;
  status: string;
  phase: string;
  processedPages: number;
  totalPages: number;
  results: Result[];
  errors: any[];
  methodId: string;
  methodHash: string;
  usage?: Record<string, any>;
  inputHash: string;
  alignments?: Record<string, { candidates: any[]; mappings: any[] }>;
}
export interface Bootstrap {
  modules: { id: ModuleId; name: string }[];
  projects: Project[];
  trashProjects?: Project[];
  documents: DocumentInfo[];
  industries: { code: string; name: string }[];
  providers: { model: string; id: string }[];
}
export type Common = {
  boot: Bootstrap;
  refresh: () => Promise<void>;
  report: (s: string) => void;
  fail: (e: unknown) => void;
};
