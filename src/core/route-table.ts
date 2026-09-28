import { Injectable, type OnModuleInit, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";

interface RouteEntry {
  method: string;
  segments: string[];
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matches(route: string[], actual: string[]): boolean {
  if (route.length !== actual.length) return false;
  return route.every((segment, i) => segment.startsWith(":") || segment === actual[i]);
}

/**
 * Every controller route (method + path template), collected from Nest's
 * metadata at boot. Express answers a known path with the wrong method as a
 * plain 404; the problem filter consults this table to say 405 instead.
 */
@Injectable()
export class RouteTable implements OnModuleInit {
  private routes: RouteEntry[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const entries: RouteEntry[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const target = wrapper.metatype;
      if (!target) continue;
      const base = this.reflector.get<string | string[] | undefined>(PATH_METADATA, target) ?? "/";
      const prototype = Object.getPrototypeOf(wrapper.instance) as object;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== "function") continue;
        const method = this.reflector.get<RequestMethod | undefined>(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const paths = this.reflector.get<string | string[] | undefined>(PATH_METADATA, handler) ?? "/";
        for (const controllerPath of Array.isArray(base) ? base : [base]) {
          for (const handlerPath of Array.isArray(paths) ? paths : [paths]) {
            entries.push({ method: RequestMethod[method], segments: [...segmentsOf(controllerPath), ...segmentsOf(handlerPath)] });
          }
        }
      }
    }
    this.routes = entries;
  }

  /** HTTP methods that would match `path` (`ALL` covers every method). Empty ⇒ unknown path. */
  methodsFor(path: string): Set<string> {
    const actual = segmentsOf(path);
    const found = new Set<string>();
    for (const route of this.routes) {
      if (matches(route.segments, actual)) found.add(route.method);
    }
    return found;
  }
}
