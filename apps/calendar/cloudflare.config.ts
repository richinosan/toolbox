import * as cfConfig from "cf/config";

export default cfConfig.defineConfig({
  worker: {
    name: "toolbox-calendar",
    compatibilityDate: "2026-09-30",
    assets: {
      htmlHandling: "drop-trailing-slash",
    },
    triggers: [
      cfConfig.triggers.fetch({
        pattern: "toolbox.richinosan.com/calendar",
        zone: "richinosan.com",
      }),
      cfConfig.triggers.fetch({
        pattern: "toolbox.richinosan.com/calendar/*",
        zone: "richinosan.com",
      }),
    ],
  },
});
