import { cn } from "@/lib/utils";

/**
 * A display title in the UI's language with the same title in the other language
 * beside it, in gold: the Tablet look's bilingual headings ("My mushafs" مصاحفي).
 */
export function BilingualTitle({
  title,
  other,
  otherLang,
  className,
}: {
  title: string;
  other: string;
  otherLang: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-3.5 gap-y-1", className)}>
      <h1 className="m-0 font-display text-[44px] font-semibold leading-[1.05]">{title}</h1>
      <span lang={otherLang} className="font-display text-[30px] font-medium text-gold-on-deep">
        {other}
      </span>
    </div>
  );
}
