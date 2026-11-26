import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy · bent Fitness · bent.build" },
      {
        name: "description",
        content:
          "How the bent Fitness iPhone app reads Apple Health weigh-ins and runs, where it sends them and how to disconnect or delete them.",
      },
    ],
  }),
  component: Privacy,
});

function Privacy() {
  return (
    <main className="privacy">
      <div className="wordmark">
        bent<span>/</span>fitness
      </div>
      <h1>bent Fitness privacy</h1>
      <p>
        bent Fitness is an iPhone app that sends your Apple Health weigh-ins and
        runs to your Fitness account at fitness.bent.build. This page covers
        what it reads, where that data goes, how it is kept and how to remove
        it.
      </p>

      <h2>What the app reads</h2>
      <ul>
        <li>
          Weigh-ins: each body mass sample, with its time and weight in
          kilograms.
        </li>
        <li>
          Running workouts: each run's start and end time, duration and
          distance.
        </li>
      </ul>
      <p>
        The app asks Apple Health for read access to body mass, workouts and
        walking and running distance, which it uses to find a run's distance. It
        reads only those types and writes nothing to Apple Health. You choose
        what to share on the Health permission screen and can change it at any
        time.
      </p>

      <h2>Where it goes</h2>
      <p>
        The app sends samples over HTTPS to fitness.bent.build and nowhere else.
        It contains no analytics, advertising or crash-reporting services. Its
        logs on the iPhone hold status codes and counts, not Health values.
      </p>
      <p>
        When you connect, you sign in to Fitness with your invited account and
        approve iPhone sync. Fitness then gives the app a device key. That key
        can import weigh-ins and runs into your account and do nothing else:
      </p>
      <ul>
        <li>
          Fitness saves each new weigh-in and run as an entry. A weigh-in or run
          that matches one you already entered stays linked to your entry.
        </li>
        <li>
          Importing a run can change which of your entered runs an earlier
          Health run is paired with, the same way any Apple Health import does.
          When a closer match takes an entered run, Fitness saves the earlier
          Health run as its own entry.
        </li>
        <li>
          Each reply tells the app your account timezone and, for each sample it
          sent, whether Fitness added it, already had it or skipped it.
        </li>
        <li>
          The key cannot read your meals, training, notes or other entries, and
          cannot change your settings.
        </li>
      </ul>

      <h2>How it is kept</h2>
      <p>
        Fitness stores your entries in a private database for your account. For
        each Health sample it has synced, it keeps the sample's time, the entry
        it became or matched, and for runs the distance and duration, so a later
        sync never adds the same sample twice. Entries stay until you change or
        remove them in Fitness. When the app connects, Fitness records a digest
        of the one-time sign-in token so the token cannot be used again. Once a
        record is more than two days old and its device key can no longer
        import, Fitness deletes it the next time any iPhone connects.
      </p>
      <p>
        On the iPhone, the app keeps its device key in the Keychain on that
        device only. Its sync progress file holds Health query positions, the
        IDs of samples waiting to be sent and counts from recent syncs, and is
        excluded from backups.
      </p>

      <h2>Disconnect or delete</h2>
      <ul>
        <li>
          Disconnect in the app's Settings stops syncing and clears the app's
          sync progress on the iPhone straight away, then asks Fitness to revoke
          the device key. If the iPhone is offline, the app asks again each time
          it opens until Fitness confirms the key no longer works.
        </li>
        <li>
          You can also revoke the key in Fitness under Manage account → API
          keys. Its name starts with "iPhone sync".
        </li>
        <li>
          To stop the app reading Health data, open the Health app, tap your
          profile picture, choose Apps under Privacy, then bent Fitness, and
          turn off each type.
        </li>
        <li>
          Weigh-ins and runs already imported stay in Fitness after you
          disconnect. Remove them in Fitness from Progress → Bodyweight and
          Progress → Sessions. Settings → Export account data and photos
          downloads everything your account holds.
        </li>
        <li>
          To delete your Fitness account and all of its data, contact the app
          owner.
        </li>
      </ul>
    </main>
  );
}
