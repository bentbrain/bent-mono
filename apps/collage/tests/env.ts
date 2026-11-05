process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from("clerk.maya-collage.bent.build$").toString("base64")}`;
process.env.CLERK_SECRET_KEY = "sk_live_handshake_fixture";
process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = "/sign-in";
