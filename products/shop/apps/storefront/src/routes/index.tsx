import { createFileRoute, Link } from "@tanstack/react-router";
import { SavedDesigns } from "@/components/saved-designs";
export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex flex-1 flex-col pt-12">
      <Link className="p-5 underline" to="/create">
        Make your own
      </Link>
      <SavedDesigns />
    </main>
  ),
});
