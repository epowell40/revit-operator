using System.Text.Json.Serialization;

namespace RevitOperator.Deployment;

internal sealed class ActivationJournal
{
    public string Schema { get; set; } = "revit-operator.activation-journal.v1";
    public string TransactionId { get; set; } = "";
    public string Operation { get; set; } = "";
    public string CreatedAtUtc { get; set; } = "";
    public List<ActivationJournalControl> Controls { get; set; } = new();
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public InstalledSafeReadAdmission? SafeReadAdmission { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ActivationJournalReleaseRootSwap? ReleaseRootSwap { get; set; }
}

internal sealed class ActivationJournalReleaseRootSwap
{
    public string FinalPath { get; set; } = "";
    public string StagingPath { get; set; } = "";
    public string DisplacedPath { get; set; } = "";
    public string FailedPath { get; set; } = "";
    public bool BeforeExists { get; set; }
    public string? BeforeTreeSha256 { get; set; }
    public string AfterTreeSha256 { get; set; } = "";
}

internal sealed class ActivationJournalControl
{
    public string Kind { get; set; } = "";
    public string Path { get; set; } = "";
    public bool BeforeExists { get; set; }
    public string? BeforeSha256 { get; set; }
    public string? BeforeBase64 { get; set; }
    public bool AfterExists { get; set; }
    public string? AfterSha256 { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Note { get; set; }
}
