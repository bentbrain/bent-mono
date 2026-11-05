#!/bin/sh
set -eu

# RIC 4 reads these from the environment, not positional arguments. Keep the
# image CMD contract while supplying the runtime's actual entrypoint settings.
test "$#" -eq 1
case "$1" in
  aws-lambda/entry.handler|aws-lambda/app-entry.handler|aws-lambda/failure-entry.handler) ;;
  *) exit 1 ;;
esac
export LAMBDA_TASK_ROOT=/function
export _HANDLER="$1"
exec /function/node_modules/.bin/aws-lambda-ric
