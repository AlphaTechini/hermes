import { useParams } from "react-router-dom";
import { AlertDetailView } from "./AlertDetailView";

/** `/alerts/:id`: deep-linkable alert detail. The same view opens in a drawer from Live. */
export function AlertPage() {
  const { id } = useParams();
  return <AlertDetailView key={id} id={id ?? ""} variant="page" />;
}
