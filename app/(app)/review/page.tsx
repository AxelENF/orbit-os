import { redirect } from "next/navigation";

export default function ReviewPage() {
  redirect("/library?filter=attention");
}
