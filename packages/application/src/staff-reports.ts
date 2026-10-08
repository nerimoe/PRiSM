import { PrismDomainError, type ReportArchiveRepository } from "@prism/core";

export type StaffReportService = {
  setArchived(input: {
    checkoutId: string;
    archived: boolean;
    staffId: string;
  }): Promise<void>;
};

export function createStaffReportService(input: {
  archives: ReportArchiveRepository;
  now: () => Date;
}): StaffReportService {
  return {
    async setArchived(command) {
      if (
        !(await input.archives.setArchived({ ...command, at: input.now() }))
      ) {
        throw new PrismDomainError("Checkout not found.", "CHECKOUT_NOT_FOUND");
      }
    },
  };
}
