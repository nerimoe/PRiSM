import { Navigate, useParams } from "react-router-dom";
export function MerchantBillingPage() {
  const { shopCode, section = "live" } = useParams();
  return <Navigate replace to={`/merchant/${shopCode}/${section}`} />;
}
