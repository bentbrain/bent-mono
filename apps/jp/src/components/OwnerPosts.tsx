import { useState, type SubmitEvent } from 'react';
import { api } from '../lib/api-client';
import { useMutation } from '@tanstack/react-query';
import { OwnerQueryProvider } from './OwnerQueryProvider';
import { Button, buttonVariants } from './ui/button';
import { Input } from './ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { Badge } from './ui/badge';
import { Field, FieldLabel } from './ui/field';

type Post = { id: string; title: string; day: string; status: string };
type Props = { posts: Post[]; day: string; beers: number };
export function OwnerPosts(props: Props) {
  return (
    <OwnerQueryProvider>
      <PostList {...props} />
    </OwnerQueryProvider>
  );
}
function PostList({ posts, day, beers }: Props) {
  const mutation = useMutation({
    mutationFn: (input: { day: FormDataEntryValue | null; count: number }) =>
      api('/api/trip/beers', input),
  });
  const [count, setCount] = useState(beers);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setSaving(true);
    try {
      await mutation.mutateAsync({ day: values.get('day'), count });
      setStatus('saved');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1>posts</h1>
        <a
          className={buttonVariants({ variant: 'default' })}
          href="/owner/posts/new"
        >
          NEW POST
        </a>
      </div>
      <Table data-feedback-id="owner-post-list" className="mb-6">
        <TableHeader>
          <TableRow>
            <TableHead>title</TableHead>
            <TableHead>day</TableHead>
            <TableHead>status</TableHead>
            <TableHead>
              <span className="sr-only">edit</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {posts.map((post) => (
            <TableRow key={post.id}>
              <TableCell>{post.title}</TableCell>
              <TableCell>{post.day}</TableCell>
              <TableCell>
                <Badge variant="outline">{post.status}</Badge>
              </TableCell>
              <TableCell>
                <a
                  className={buttonVariants({ variant: 'link', size: 'sm' })}
                  href={`/owner/posts/${post.id}`}
                >
                  EDIT
                </a>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <form
        id="beer-form"
        className="mt-6 flex flex-wrap items-end gap-3"
        data-feedback-id="daily-beer-editor"
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <Field className="w-auto">
          <FieldLabel htmlFor="beer-day">day</FieldLabel>
          <Input
            id="beer-day"
            name="day"
            aria-label="Beer day"
            type="date"
            defaultValue={day}
            required
            className="w-[150px]"
          />
        </Field>
        <Button
          type="button"
          aria-label="Remove a beer"
          onClick={() => {
            setCount(Math.max(0, count - 1));
          }}
        >
          −
        </Button>
        <Field className="w-auto">
          <FieldLabel htmlFor="beer-count">beers</FieldLabel>
          <Input
            id="beer-count"
            name="count"
            aria-label="Daily beers"
            type="number"
            min="0"
            max="100"
            value={count}
            onChange={(event) => {
              setCount(Math.max(0, Math.min(100, Number(event.target.value))));
            }}
            required
            className="w-[70px]"
          />
        </Field>
        <Button
          type="button"
          aria-label="Add a beer"
          onClick={() => {
            setCount(Math.min(100, count + 1));
          }}
        >
          +
        </Button>
        <Button variant="default" type="submit" disabled={saving}>
          SAVE
        </Button>
      </form>
      <p className="my-3 whitespace-pre-wrap empty:hidden" role="status">
        {status}
      </p>
    </>
  );
}
