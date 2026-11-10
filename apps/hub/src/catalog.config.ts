export interface HubCatalogModule {
  code: string;
  name: string;
  description: string;
  route: string;
  enabled: boolean;
}

// Enable a module only after its route is integrated and it can return to the Hub.
export const hubCatalogConfig: HubCatalogModule[] = [
  {
    code: 'lessons-learned',
    name: 'Lessons Learned',
    description: 'Capture, review, and reuse lessons from project experience.',
    route: '/lessons-learned',
    enabled: false,
  },
  {
    code: 'resource-allocation',
    name: 'Tech Resource Allocation',
    description: 'Request and coordinate technology resources across projects.',
    route: '/resource-allocation',
    enabled: false,
  },
];
