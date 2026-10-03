import * as cfConfig from "@cloudflare/config";

export default cfConfig.defineConfig({
  worker: {
    name: "toolbox-image",
    compatibilityDate: "2026-09-30",
    assets: {
      htmlHandling: "drop-trailing-slash",
    },
    triggers: [
      cfConfig.triggers.fetch({
        pattern: "toolbox.richinosan.com/image",
        zone: "richinosan.com",
      }),
      cfConfig.triggers.fetch({
        pattern: "toolbox.richinosan.com/image/*",
        zone: "richinosan.com",
      }),
    ],
  },
});
