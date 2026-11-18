import { Link, useNavigate } from "@tanstack/react-router";
import { addDays, dateSearch, formatDate, formatShortDate } from "../domain";
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
          <Link
            className="icon-button"
            to={path}
            search={dateSearch(previous, today)}
            aria-label={`Previous day, ${formatDate(previous)}`}
          >
            <Icon name="back" />
          </Link>
        )}
        <p className="date-label">
          <strong>{isToday ? "Today" : formatShortDate(date)}</strong>
          <span>{isToday ? formatShortDate(date) : date.slice(0, 4)}</span>
        </p>
        {step && (
          <Link
            className="icon-button"
            to={path}
            search={dateSearch(next, today)}
            aria-label={`Next day, ${formatDate(next)}`}
          >
            <Icon name="forward" />
          </Link>
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
          <Link to={path} search={{}}>
            Return to today
          </Link>
        </p>
      )}
    </div>
  );
}
