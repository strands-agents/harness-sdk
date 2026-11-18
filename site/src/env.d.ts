/// <reference types="astro/client" />

declare global {
  namespace App {
    interface Locals {
      // Needed to avoid casts when accessing the starlight route
      starlightRoute: import('@astrojs/starlight/route-data').StarlightRouteData
      // Page-specific JSON-LD nodes, set in page frontmatter before Head.astro renders
      structuredData?: import('./util/structured-data').JsonLdNode[]
    }
  }
}

export {}
