import { ComparisonWorkbench } from "@/components/dashboard/comparison-workbench";
import { headers } from "next/headers";
import { getSiteAccess } from "@/server/site-access";
import { siteCatalog } from "@/server/public-data";
import { catalogRevision } from "@/server/site-runtime";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let access;
  try {
    access = await getSiteAccess(await headers());
  } catch {
    return (
      <main className="main-content">
        <section className="panel">
          <h1>Access unavailable</h1>
          <p>Use the configured public site or sign in through the owner site.</p>
        </section>
      </main>
    );
  }
  return (
    <ComparisonWorkbench
      catalog={siteCatalog(access.owner)}
      owner={access.owner}
      ownerOrigin={access.ownerOrigin}
      publicOrigin={access.publicOrigin}
      catalogRevision={catalogRevision()}
    />
  );
}
