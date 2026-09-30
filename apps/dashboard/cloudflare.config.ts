import * as cfConfig from "cf/config";

export default cfConfig.defineConfig({
  worker: {
    name: "toolbox-dashboard",
    compatibilityDate: "2026-09-30",
    assets: {
      htmlHandling: "drop-trailing-slash",
    },
    triggers: [
      // より具体的な route（/calendar など）は各ツールの Worker が優先して処理する。
      cfConfig.triggers.fetch({
        pattern: "toolbox.richinosan.com/*",
        zone: "richinosan.com",
      }),
    ],
  },
});
