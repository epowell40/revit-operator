export type RevitActionEffect = "read" | "preview" | "apply";

export declare function canonicalRevitActionPath(pathname: string): string;
export declare function conditionalActionPathEffect(pathname: string, body?: unknown): RevitActionEffect | undefined;
export declare function pathLooksWrite(pathname: string, body?: unknown, method?: string): boolean;
export declare function revitRouteEffect(pathname: string, method: string, body?: unknown): RevitActionEffect;
export declare function revitRouteCertificationEffect(pathname: string, method: string, body?: unknown): RevitActionEffect;
export declare function revitRouteEffectWhenBodyUnavailable(pathname: string, method: string): RevitActionEffect;
