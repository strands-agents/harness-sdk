/// <reference types="astro/client" />

declare global {
  namespace App {
    interface Locals {
      // Needed to avoid casts when accessing the starlight route
      starlightRoute: import('@astrojs/starlight/route-data').StarlightRouteData
    }
  }
}

export {}
