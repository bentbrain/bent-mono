import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@bent/ui/sdk/button";
import { Field, FieldLabel, Input } from "@bent/ui/sdk/field";
import {
  addDays,
  dateSearch,
  formatDate,
  formatShortDate,
} from "@bent/fitness-contracts/domain";
import { useAccount } from "./account-context";
import { Icon } from "./icons";

/**
 * Shows the date a screen is using, with day steps and a date picker. Each
 * change adds a browser history entry. On another day, the line under the
 * date returns to today, so the bar keeps its height whichever day is shown.
 */
export function DateBar({
  path,
  step = false,
}: {
  path: "/" | "/food" | "/body";
  step?: boolean;
}) {
  const { date, today } = useAccount();
  const navigate = useNavigate();
  const isToday = date === today;
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  return (
    <div className="date-bar" data-feedback-private data-feedback-redact>
      <div className={step ? "date-row is-stepped" : "date-row"}>
        {step && (
          <Button
            className="icon-button"
            render={
              <Link
                to={path}
                search={dateSearch(previous, today)}
                activeOptions={{ exact: true }}
                aria-label={`Previous day, ${formatDate(previous)}`}
              />
            }
          >
            <Icon name="back" />
          </Button>
        )}
        <p className="date-label">
          <strong>
            {isToday ? "Today" : formatShortDate(date)}
            {!isToday && (
              <span className="visually-hidden">
                {" "}
                {date.slice(0, 4)}. New entries here use this date.
              </span>
            )}
          </strong>
          {isToday ? (
            <span>{formatShortDate(date)}</span>
          ) : (
            <Button
              render={
                <Link
                  to={path}
                  search={{}}
                  activeOptions={{ exact: true }}
                  aria-label={`Back to today, ${formatDate(today)}`}
                />
              }
            >
              Back to today
            </Button>
          )}
        </p>
        {step && (
          <Button
            className="icon-button"
            render={
              <Link
                to={path}
                search={dateSearch(next, today)}
                activeOptions={{ exact: true }}
                aria-label={`Next day, ${formatDate(next)}`}
              />
            }
          >
            <Icon name="forward" />
          </Button>
        )}
        <Field className="date-pick">
          <FieldLabel>Choose date</FieldLabel>
          <Input
            type="date"
            value={date}
            onValueChange={(value) =>
              void navigate({
                to: path,
                search: dateSearch(value || today, today),
              })
            }
          />
        </Field>
      </div>
    </div>
  );
}
