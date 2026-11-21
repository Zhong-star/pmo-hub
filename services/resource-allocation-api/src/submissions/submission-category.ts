export enum ResourceRequestCategory {
  DemandAnalysis = 'DEMAND_ANALYSIS',
  PocBbp = 'POC_BBP',
  ExecutionProject = 'EXECUTION_PROJECT',
  ExecutionFastTrack = 'EXECUTION_FAST_TRACK',
  ExecutionEnhancement = 'EXECUTION_ENHANCEMENT',
}

export enum ResourceSubmissionLineStatus {
  Received = 'RECEIVED',
  Processing = 'PROCESSING',
  Succeeded = 'SUCCEEDED',
  Failed = 'FAILED',
}

export enum ResourceRequestDecisionState {
  WaitingForPresentation = 'WAITING_FOR_PRESENTATION',
}
