import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/app/_components/ui/card";
import { SignIn } from "@clerk/nextjs";
import { InAppBrowserDetector } from "@/app/_components/in-app-browser-detector";

export default function Page() {
  return (
    <main className="grid h-full place-items-center">
      <div className="container mx-auto grid place-items-center gap-5">
        <InAppBrowserDetector>
          <Card className="max-w-lg bg-white p-0">
            <CardHeader>
              <CardTitle>Sign in</CardTitle>
              <CardDescription>
                Sign in or create an account to make collages.
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <p className="text-xs text-muted-foreground">
                Your details are used to create a profile and save your
                collages.
              </p>
            </CardFooter>
          </Card>

          <SignIn />
        </InAppBrowserDetector>
      </div>
    </main>
  );
}
