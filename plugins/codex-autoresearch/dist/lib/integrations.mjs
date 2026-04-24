import { listBuiltInRecipes, loadRecipeCatalog } from "./recipes.mjs";
//#region lib/integrations.ts
const BUILT_IN_INTEGRATIONS = [
	{
		id: "local-recipe-catalog",
		title: "Local recipe catalog",
		status: "available",
		description: "Loads recipe JSON from a local file path."
	},
	{
		id: "remote-recipe-catalog",
		title: "Remote recipe catalog",
		status: "available",
		description: "Loads recipe JSON from an HTTP or HTTPS URL."
	},
	{
		id: "model-command",
		title: "Model command",
		status: "available",
		description: "Runs a user-provided command that prints JSON gap candidates."
	},
	{
		id: "live-dashboard-actions",
		title: "Live dashboard actions",
		status: "available",
		description: "Provides local HTTP endpoints for safe dashboard actions."
	}
];
async function integrationsCommand(subcommand, args = {}) {
	if (subcommand === "list" || !subcommand) return {
		ok: true,
		integrations: BUILT_IN_INTEGRATIONS
	};
	if (subcommand === "doctor") {
		const checks = [...BUILT_IN_INTEGRATIONS];
		if (args.catalog) try {
			const recipes = await loadRecipeCatalog(args.catalog);
			checks.push({
				id: "recipe-catalog-input",
				title: "Configured recipe catalog",
				status: "available",
				description: `Loaded ${recipes.length} recipes from ${args.catalog}.`
			});
		} catch (error) {
			checks.push({
				id: "recipe-catalog-input",
				title: "Configured recipe catalog",
				status: "blocked",
				description: error.message
			});
		}
		return {
			ok: true,
			integrations: checks
		};
	}
	if (subcommand === "sync-recipes") {
		const catalogRecipes = args.catalog ? await loadRecipeCatalog(args.catalog) : [];
		return {
			ok: true,
			synced: false,
			recipes: [...listBuiltInRecipes(), ...catalogRecipes],
			message: args.catalog ? "Loaded recipe catalog. No local cache was written; pass the catalog again or add it to your workflow." : "No catalog provided; returning built-in recipes."
		};
	}
	throw new Error(`Unknown integrations subcommand: ${subcommand}`);
}
//#endregion
export { integrationsCommand };
