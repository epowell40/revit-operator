using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace RevitOperator.DynamicRevitWorker;

// Only the generated source tree is rewritten. The host-supplied callback is
// installed by a compiler-owned bridge after source admission, never by task code.
// This is cooperative control of managed source, NOT a process sandbox or a way
// to interrupt an already-running Revit/BCL call.
internal sealed class NativeProgramInstrumentation : CSharpSyntaxRewriter
{
    internal const string BoundaryType = "RevitOperator.Generated.NativeExecutionBoundaryV1";
    private readonly SemanticModel _model;
    internal NativeProgramInstrumentation(SemanticModel model) => _model = model;
    private static StatementSyntax Tick() => SyntaxFactory.ParseStatement("global::" + BoundaryType + ".Checkpoint();");
    private static StatementSyntax Location(SyntaxNode original)
    {
        // Physical submitted-source coordinates, never task-controlled #line mappings.
        var position = original.SyntaxTree.GetLineSpan(original.Span).StartLinePosition;
        return SyntaxFactory.ParseStatement("global::" + BoundaryType + ".SourceLocation(" +
            (position.Line + 1) + "," + (position.Character + 1) + ");");
    }
    private static SyntaxList<StatementSyntax> Located(SyntaxList<StatementSyntax> original, SyntaxList<StatementSyntax> rewritten)
    {
        var statements = new List<StatementSyntax>();
        for (var i = 0; i < original.Count; i++)
        {
            if (original[i] is not LocalFunctionStatementSyntax) statements.Add(Location(original[i]));
            statements.Add(rewritten[i]);
        }
        return SyntaxFactory.List(statements);
    }
    public override SyntaxNode? VisitBlock(BlockSyntax node)
    {
        var block = (BlockSyntax)base.VisitBlock(node)!;
        return block.WithStatements(Located(node.Statements, block.Statements).Insert(0, Tick()));
    }
    public override SyntaxNode? VisitSwitchSection(SwitchSectionSyntax node)
    {
        var section = (SwitchSectionSyntax)base.VisitSwitchSection(node)!;
        return section.WithStatements(Located(node.Statements, section.Statements));
    }
    public override SyntaxNode? Visit(SyntaxNode? node)
    {
        var rewritten = base.Visit(node);
        // Preserve local declaration scopes in blocks/switch sections. Only
        // embedded statements get a block, like the existing loop instrumentation.
        if (node is StatementSyntax and not BlockSyntax && rewritten is StatementSyntax statement &&
            node.Parent is IfStatementSyntax or ElseClauseSyntax or WhileStatementSyntax or DoStatementSyntax or
                ForStatementSyntax or ForEachStatementSyntax or ForEachVariableStatementSyntax or
                UsingStatementSyntax or LockStatementSyntax or FixedStatementSyntax or LabeledStatementSyntax)
            return SyntaxFactory.Block(Tick(), Location(node), statement);
        return rewritten;
    }
    private static StatementSyntax LoopBody(StatementSyntax body) => body is BlockSyntax ? body : SyntaxFactory.Block(Tick(), body);
    public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
    { var n = (WhileStatementSyntax)base.VisitWhileStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }
    public override SyntaxNode? VisitDoStatement(DoStatementSyntax node)
    { var n = (DoStatementSyntax)base.VisitDoStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }
    public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
    { var n = (ForStatementSyntax)base.VisitForStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }
    public override SyntaxNode? VisitForEachStatement(ForEachStatementSyntax node)
    { var n = (ForEachStatementSyntax)base.VisitForEachStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }
    public override SyntaxNode? VisitForEachVariableStatement(ForEachVariableStatementSyntax node)
    { var n = (ForEachVariableStatementSyntax)base.VisitForEachVariableStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }

    private static BlockSyntax ExpressionBody(ExpressionSyntax expression, bool returnsVoid, SyntaxNode original) => SyntaxFactory.Block(Tick(), Location(original),
        expression is ThrowExpressionSyntax thrown ? SyntaxFactory.ThrowStatement(thrown.Expression) :
        returnsVoid ? SyntaxFactory.ExpressionStatement(expression) : SyntaxFactory.ReturnStatement(expression));
    public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        var n = (MethodDeclarationSyntax)base.VisitMethodDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression,
            _model.GetDeclaredSymbol(node)!.ReturnsVoid, node.ExpressionBody!.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
    {
        var n = (LocalFunctionStatementSyntax)base.VisitLocalFunctionStatement(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression,
            _model.GetDeclaredSymbol(node)!.ReturnsVoid, node.ExpressionBody!.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
    {
        var n = (ConstructorDeclarationSyntax)base.VisitConstructorDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression, true, node.ExpressionBody!.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitOperatorDeclaration(OperatorDeclarationSyntax node)
    {
        var n = (OperatorDeclarationSyntax)base.VisitOperatorDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression, false, node.ExpressionBody!.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitConversionOperatorDeclaration(ConversionOperatorDeclarationSyntax node)
    {
        var n = (ConversionOperatorDeclarationSyntax)base.VisitConversionOperatorDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression, false, node.ExpressionBody!.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitAccessorDeclaration(AccessorDeclarationSyntax node)
    {
        var n = (AccessorDeclarationSyntax)base.VisitAccessorDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression, !n.IsKind(SyntaxKind.GetAccessorDeclaration), node.ExpressionBody!.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    private static AccessorListSyntax Getter(ExpressionSyntax expression, SyntaxNode original) => SyntaxFactory.AccessorList(
        SyntaxFactory.SingletonList(SyntaxFactory.AccessorDeclaration(SyntaxKind.GetAccessorDeclaration).WithBody(ExpressionBody(expression, false, original))));
    public override SyntaxNode? VisitPropertyDeclaration(PropertyDeclarationSyntax node)
    {
        var n = (PropertyDeclarationSyntax)base.VisitPropertyDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithAccessorList(Getter(n.ExpressionBody.Expression, node.ExpressionBody!.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitIndexerDeclaration(IndexerDeclarationSyntax node)
    {
        var n = (IndexerDeclarationSyntax)base.VisitIndexerDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithAccessorList(Getter(n.ExpressionBody.Expression, node.ExpressionBody!.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    private bool LambdaVoid(LambdaExpressionSyntax node) =>
        (_model.GetTypeInfo(node).ConvertedType as INamedTypeSymbol)?.DelegateInvokeMethod?.ReturnsVoid ?? false;
    public override SyntaxNode? VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node)
    {
        var n = (SimpleLambdaExpressionSyntax)base.VisitSimpleLambdaExpression(node)!;
        return n.Body is ExpressionSyntax e ? n.WithBody(ExpressionBody(e, LambdaVoid(node), node.Body)) : n;
    }
    public override SyntaxNode? VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node)
    {
        var n = (ParenthesizedLambdaExpressionSyntax)base.VisitParenthesizedLambdaExpression(node)!;
        return n.Body is ExpressionSyntax e ? n.WithBody(ExpressionBody(e, LambdaVoid(node), node.Body)) : n;
    }

    internal static string Bridge(string entryType) => @"
namespace RevitOperator.Generated {
 public static class NativeExecutionBoundaryV1 {
  [System.ThreadStatic] private static System.Action callback;
  [System.ThreadStatic] private static int sourceLine;
  [System.ThreadStatic] private static int sourceColumn;
  [System.ThreadStatic] private static bool hostFailure;
  public static void SourceLocation(int line, int column) { sourceLine=line; sourceColumn=column; }
  public static void Checkpoint() {
   var current = callback;
   if(current == null) throw new System.InvalidOperationException(""Native execution requires the host checkpoint."");
   try { current(); } catch { hostFailure=true; throw; }
  }
  public static string Run(Autodesk.Revit.DB.Document document, System.Action checkpoint) {
   if(checkpoint == null) throw new System.ArgumentNullException(""checkpoint"");
   if(callback != null) throw new System.InvalidOperationException(""Nested native program entry is not allowed."");
   callback = checkpoint;
   sourceLine=0; sourceColumn=0; hostFailure=false;
   try {
    Checkpoint();
    var result = global::" + entryType + @".Execute(document);
    Checkpoint();
    if(result == null || result.Length > 32768) throw new System.InvalidOperationException(""Native program result exceeds the bounded text contract."");
    return result;
   } catch(System.Exception error) {
    // Diagnostic only. Rethrow the SAME exception; cancellation/settlement
    // decisions must never depend on an annotation or change exception class.
    if(!hostFailure && sourceLine>0 && !(error is System.OperationCanceledException) && !(error is System.TimeoutException)) {
     try {
      error.Data[""revit_operator.native_source_line.v1""]=sourceLine;
      error.Data[""revit_operator.native_source_column.v1""]=sourceColumn;
     } catch { }
    }
    throw;
   } finally { callback=null; sourceLine=0; sourceColumn=0; hostFailure=false; }
  }
 }
}";
}
