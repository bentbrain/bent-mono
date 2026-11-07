import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../_components/ui/card";

function Page() {
  return (
    <div className="grid size-full place-items-center">
      <Card className="container mx-auto max-w-sm">
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
        </CardHeader>
        <CardContent>
          <p>Check the address or return to the home page.</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default Page;
