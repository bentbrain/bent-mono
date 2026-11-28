import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@bent/ui/sdk/button";
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
 * change adds a browser history entry.
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
      <div className="date-row">
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
          <strong>{isToday ? "Today" : formatShortDate(date)}</strong>
          <span>{isToday ? formatShortDate(date) : date.slice(0, 4)}</span>
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
        <label className="date-pick">
          <span>Choose date</span>
          <input
            id="view-date"
            type="date"
            value={date}
            onChange={(event) =>
              void navigate({
                to: path,
                search: dateSearch(event.target.value || today, today),
              })
            }
          />
        </label>
      </div>
      {!isToday && (
        <p className="date-banner">
          <span>
            Viewing {formatDate(date)}. New entries here use this date.
          </span>{" "}
          <Button
            render={
              <Link to={path} search={{}} activeOptions={{ exact: true }} />
            }
          >
            Return to today
          </Button>
        </p>
      )}
    </div>
  );
}
